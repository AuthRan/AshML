"""Re-evaluate the Space's model over the full CIFAR-10 test set.

    make space-verify

Runs inside the model-server image, because that is where the pinned torch is and
because using the serving image is the point: a check run against a different build of
the framework proves less than it looks like it does.

Loads the weights the way `app.py` does -- through `serve.HOLDER.load()`, the real path
-- and pushes the whole 10 000-image test set through `serve.decode_instances`, the same
normalisation the deployed pod applies. If this does not reproduce the accuracy AshML
recorded for the artifact, then the Space is serving something other than the model that
was evaluated, which is the failure the whole provenance chain exists to catch.
"""
import os, pickle, sys
from pathlib import Path

SPACE = Path(os.environ.get("SPACE_DIR", "/space"))
os.environ["ASHML_MODEL_URL"] = (SPACE / "model.pt").as_uri()
os.environ["ASHML_MODEL_ARCH"] = "resnet18-cifar"
sys.path.insert(0, str(SPACE))

import serve
import torch

serve.HOLDER.load()
print(f"loaded: ready={serve.HOLDER.ready} arch={serve.ARCH}")

data = Path(os.environ.get("DATA_DIR", "/data"))
with open(data / "cifar-10-batches-py" / "test_batch", "rb") as fh:
    batch = pickle.load(fh, encoding="bytes")

raw = batch[b"data"]          # (10000, 3072) uint8, channel-major
labels = batch[b"labels"]
images = raw.reshape(-1, 3, 32, 32).transpose(0, 2, 3, 1)   # -> HWC, 0..255

correct = 0
total = 0
loss_sum = 0.0
lossfn = torch.nn.CrossEntropyLoss(reduction="sum")

for start in range(0, len(images), 500):
    chunk = images[start:start + 500]
    target = torch.tensor(labels[start:start + 500])
    # Exactly the payload shape the deployed server takes over HTTP.
    tensor = serve.decode_instances({"instances": chunk.tolist()})
    with torch.no_grad():
        logits = serve.HOLDER.model(tensor)
    loss_sum += float(lossfn(logits, target))
    correct += int((logits.argmax(dim=1) == target).sum())
    total += len(chunk)
    print(f"  {total}/{len(images)}  running acc {correct/total:.4f}", flush=True)

print(f"\nRESULT accuracy {correct/total:.4f}  loss {loss_sum/total:.4f}  over {total} images")
