"""Export a registered AshML model artifact to ONNX, and prove the export is the model.

    make space-onnx

A browser cannot run `serve.py`, so the static demo runs the same *weights* through a
different runtime. That substitution is only honest if it is checked, so this does not
merely export: it re-evaluates both the torch model and the exported graph over the full
CIFAR-10 test set and refuses to write anything unless they agree with each other and
with the accuracy AshML recorded for the artifact.

The architecture and the normalisation come from `serve.py` rather than being restated
here, for the reason that file already gives: a second implementation of the training
transform is a silent accuracy loss that no error message would ever point at.
"""

import json
import os
import pickle
import sys
from pathlib import Path

SPACE = Path(os.environ.get("SPACE_DIR", "/space"))
DATA = Path(os.environ.get("DATA_DIR", "/data"))
OUT = Path(os.environ.get("OUT_DIR", "/out"))

os.environ["ASHML_MODEL_URL"] = (SPACE / "model.pt").as_uri()
os.environ["ASHML_MODEL_ARCH"] = "resnet18-cifar"
os.environ.setdefault("ASHML_MAX_BATCH", "500")
sys.path.insert(0, str(SPACE))

import numpy as np
import onnxruntime as ort
import torch

import serve

serve.HOLDER.load()
model = serve.HOLDER.model
print(f"loaded {serve.ARCH} from {serve.HOLDER.source_uri}", flush=True)

OUT.mkdir(parents=True, exist_ok=True)
onnx_path = OUT / "model.onnx"

# The exported graph takes an already-normalised NCHW batch, exactly what
# `serve.decode_instances` produces. Keeping the transform outside the graph means the
# browser runs the same three steps in the same order as `ash predict` and the pod --
# and if it ever drifts, the accuracy check below is what catches it.
torch.onnx.export(
    model,
    torch.zeros(1, 3, 32, 32),
    str(onnx_path),
    input_names=["pixels"],
    output_names=["logits"],
    dynamic_axes={"pixels": {0: "batch"}, "logits": {0: "batch"}},
    opset_version=17,
    # One file, not a graph plus a sidecar of weights. The default splits tensors into
    # `model.onnx.data` above a size threshold, which onnxruntime-web can be made to
    # fetch but only by teaching the page where the second file lives -- an extra
    # request that can 404 on its own and leave a page that loaded "successfully" with
    # no weights in it. 45 MB is far below the 2 GB protobuf limit, so there is nothing
    # to gain by splitting.
    dynamo=False,
)
print(f"exported {onnx_path} ({onnx_path.stat().st_size} bytes)", flush=True)

with open(DATA / "cifar-10-batches-py" / "test_batch", "rb") as fh:
    batch = pickle.load(fh, encoding="bytes")
images = batch[b"data"].reshape(-1, 3, 32, 32).transpose(0, 2, 3, 1)  # HWC, 0..255
labels = np.array(batch[b"labels"])

session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])

torch_correct = onnx_correct = agree = total = 0
torch_loss = 0.0
lossfn = torch.nn.CrossEntropyLoss(reduction="sum")

for start in range(0, len(images), 500):
    chunk = images[start:start + 500]
    target = torch.tensor(labels[start:start + 500])

    tensor = serve.decode_instances({"instances": chunk.tolist()})
    with torch.no_grad():
        torch_logits = model(tensor)
    onnx_logits = torch.tensor(
        session.run(["logits"], {"pixels": tensor.numpy().astype(np.float32)})[0]
    )

    torch_loss += float(lossfn(torch_logits, target))
    torch_pred = torch_logits.argmax(dim=1)
    onnx_pred = onnx_logits.argmax(dim=1)
    torch_correct += int((torch_pred == target).sum())
    onnx_correct += int((onnx_pred == target).sum())
    agree += int((torch_pred == onnx_pred).sum())
    total += len(chunk)
    print(f"  {total}/{len(images)}  torch {torch_correct/total:.4f}  "
          f"onnx {onnx_correct/total:.4f}  agree {agree/total:.4f}", flush=True)

torch_acc = torch_correct / total
onnx_acc = onnx_correct / total
agreement = agree / total

print(f"\ntorch  accuracy {torch_acc:.4f}  loss {torch_loss/total:.4f}")
print(f"onnx   accuracy {onnx_acc:.4f}")
print(f"agree  {agreement:.4f} of {total} predictions")

recorded = json.loads((SPACE / "provenance.json").read_text())
expected = recorded.get("metrics", {}).get("val_accuracy")

problems = []
if expected is not None and abs(torch_acc - expected) > 1e-4:
    problems.append(f"torch scored {torch_acc:.4f}, AshML recorded {expected:.4f}")
if abs(onnx_acc - torch_acc) > 1e-4:
    problems.append(f"onnx scored {onnx_acc:.4f}, torch scored {torch_acc:.4f}")
if agreement < 0.999:
    problems.append(f"the two runtimes disagree on {(1-agreement)*100:.2f}% of images")

if problems:
    onnx_path.unlink(missing_ok=True)
    print("\nREFUSED -- export deleted:", *problems, sep="\n  ", file=sys.stderr)
    sys.exit(1)

(OUT / "onnx-verification.json").write_text(json.dumps({
    "artifact_id": recorded.get("artifact_id"),
    "recorded_val_accuracy": expected,
    "torch_accuracy": round(torch_acc, 4),
    "onnx_accuracy": round(onnx_acc, 4),
    "runtime_agreement": round(agreement, 4),
    "test_images": total,
    "opset": 17,
}, indent=2) + "\n")

print(f"\nOK -- ONNX reproduces the recorded {expected:.4f} over all {total} test images")
