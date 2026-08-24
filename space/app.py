"""The serving slice of AshML, as a Hugging Face Space.

This does not reimplement inference. It imports `serve.py` -- the model server AshML
deploys into the cluster -- and drives it through its real load path, so that what
answers here and what answers in a Pod are the same code reading the same weights with
the same normalisation.

The one thing that differs is where the weights come from, and that difference is
already a supported branch of `serve.resolve_model_url`: in the cluster the server is
handed an *artifact id* and exchanges it with the control plane for a time-limited
download, because a presigned URL baked into a manifest expires and a pod restarting
hours later would crash-loop on a dead signature. There is no control plane here, so the
Space uses the direct-URL branch against a local `file://` path. Everything after that --
the fetch, `load_state_dict(strict=True)`, the forward pass that has to succeed before
the model is called ready -- is unchanged.
"""

import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODEL_PATH = HERE / "model.pt"
PROVENANCE_PATH = HERE / "provenance.json"

# Set before importing `serve`: it reads its configuration into module-level constants at
# import time, which is what lets the container be configured entirely by env.
os.environ.setdefault("ASHML_MODEL_URL", MODEL_PATH.as_uri())
os.environ.setdefault("ASHML_MODEL_ARCH", "resnet18-cifar")

sys.path.insert(0, str(HERE))
import serve  # noqa: E402  -- must follow the env above

import gradio as gr  # noqa: E402
import torch  # noqa: E402
from PIL import Image  # noqa: E402

CLASSES = serve.CIFAR10_CLASSES


def load_provenance():
    """What produced these weights. Absent is a state to render, not to crash on."""
    try:
        return json.loads(PROVENANCE_PATH.read_text())
    except (OSError, ValueError):
        return {}


PROVENANCE = load_provenance()

# The real load path, synchronously: in the cluster this runs on a background thread so
# the HTTP server can bind and answer /healthz while several hundred megabytes download.
# Here there is no probe to satisfy and a Space that renders before its model exists is
# just a page that fails on first use, so the import blocks until it is ready.
serve.HOLDER.load()


def preprocess(image):
    """Centre-crop and area-average to 32x32, and say what that did.

    This is the client half of the split `ash predict` makes: the *server* owns the
    normalisation its weights were trained with, and never sees a second implementation
    of it, but somebody has to turn a photograph into 32x32 pixels first. PIL's BOX
    filter is the area average `packages/cli/src/png.js` implements by hand.
    """
    steps = [f"{image.width}x{image.height} {image.mode}"]

    if image.mode in ("RGBA", "LA", "P"):
        # Composite onto white rather than dropping the alpha channel: discarding it
        # leaves whatever colour happened to sit under a transparent pixel, which for
        # most PNGs is black, and a black halo is a feature the model was never shown.
        rgba = image.convert("RGBA")
        flat = Image.new("RGB", rgba.size, (255, 255, 255))
        flat.paste(rgba, mask=rgba.split()[3])
        image = flat
        steps.append("transparency composited onto white")
    else:
        image = image.convert("RGB")

    side = min(image.width, image.height)
    if image.width != image.height:
        left = (image.width - side) // 2
        top = (image.height - side) // 2
        image = image.crop((left, top, left + side, top + side))
        steps.append(f"centre-cropped to {side}x{side}")

    if side != 32:
        image = image.resize((32, 32), Image.BOX)
        steps.append("resized to 32x32 (area average)")

    return image, ", ".join(steps)


def predict(image):
    if image is None:
        return None, "", ""

    small, how = preprocess(image)

    # Hand the server pixels in the shape the deployed one takes over HTTP -- 32x32x3 in
    # 0..255 -- and let `serve.decode_instances` apply the training transform. Normalising
    # here instead would be the second implementation the split exists to prevent.
    instance = [[list(small.getpixel((x, y))) for x in range(32)] for y in range(32)]
    batch = serve.decode_instances({"instances": [instance]})

    with torch.no_grad():
        probabilities = torch.softmax(serve.HOLDER.model(batch), dim=1)[0]

    scores = {CLASSES[i]: float(probabilities[i]) for i in range(len(CLASSES))}
    top = max(scores, key=scores.get)

    # Provenance on every answer, not behind a toggle. A prediction nobody can attribute
    # to a model version is how the wrong model serves for a week.
    served_by = "\n".join(
        f"**{label}** · {value}"
        for label, value in (
            ("model", PROVENANCE.get("model", "resnet18-cifar10")),
            ("version", f"v{PROVENANCE['version']}" if PROVENANCE.get("version") else "—"),
            ("artifact", PROVENANCE.get("artifact_id", "—")),
            ("architecture", serve.ARCH),
        )
    )

    detail = (
        f"**What the model was shown:** {how}\n\n"
        f"**Prediction:** {top} ({scores[top] * 100:.1f}% confidence)\n\n"
        f"---\n\n{served_by}"
    )
    return scores, detail, ""


def run_metrics_markdown():
    p = PROVENANCE
    if not p:
        return ""
    dash = "—"
    rows = [
        ("Trained by", "AshML — scheduled, executed on Kubernetes, reported by the Python SDK"),
        ("Run", f"`{p.get('job_id', dash)}`"),
        ("Experiment", p.get("experiment") or dash),
        ("Dataset", f"`{p['dataset']}`" if p.get("dataset") else dash),
        ("Seed", str(p.get("seed") or dash)),
        ("Epochs", str(p.get("epochs") or dash)),
        ("Last logged step", str(p.get("last_logged_step") or dash)),
        ("Test accuracy", p.get("accuracy", dash)),
        ("Test loss", p.get("loss", dash)),
        ("Image", f"`{p['image']}`" if p.get("image") else dash),
        ("Framework", p.get("framework") or dash),
        ("Artifact", f"`{p.get('artifact_id', dash)}`"),
        ("Artifact verified", "yes — AshML asked the bucket"
            if p.get("artifact_verified") else "not confirmed"),
    ]
    return "\n".join(f"| {k} | {v} |" for k, v in rows)


HEADER = """
# AshML — ResNet-18 / CIFAR-10

This is the **serving slice** of [AshML](https://github.com/AuthRan/AshML), a
Kubernetes-native ML platform: the same `serve.py` the cluster deploys, loading the same
artifact an AshML training run produced, normalising exactly the way it was trained.

It is not the platform. The scheduler, the executor, the artifact verification, the model
registry and the traffic-splitting router need a cluster — and while the control plane API
authenticates every request, it has no rate limiting and no audit of refusals, so it is
deliberately not on a public URL.
[**The repository**](https://github.com/AuthRan/AshML) ·
[**The project site**](https://authran.github.io/AshML/)
"""

CAVEAT = """
### Read the answer sceptically

**This is not a CIFAR-10 result.** ResNet-18 reaches ~95% trained the 100–200 epochs the
literature uses. This is **one epoch on a CPU** — undertrained on purpose, because the
thing being demonstrated is that the platform carried a real workload end to end, not
that the model is good. Expect roughly two in three correct.

CIFAR-10 is 32×32. Anything you upload is centre-cropped and area-averaged down to that
before the model sees it, and the page tells you what it did — a confident prediction
about a 32×32 crop of a photograph is still a prediction about a 32×32 crop of a
photograph.
"""

with gr.Blocks(title="AshML — ResNet-18 / CIFAR-10", theme=gr.themes.Soft()) as demo:
    gr.Markdown(HEADER)

    with gr.Row():
        with gr.Column(scale=1):
            image_in = gr.Image(type="pil", label="An image", height=300)
            go = gr.Button("Predict", variant="primary")
            examples_dir = HERE / "examples"
            if examples_dir.is_dir():
                files = sorted(str(p) for p in examples_dir.glob("*.png"))
                if files:
                    # Real CIFAR-10 *test* images with the true label in the filename, so
                    # an answer can be checked rather than admired. A demo whose examples
                    # all score correct is predicting on its own training set.
                    gr.Examples(examples=[[f] for f in files], inputs=image_in,
                                label="CIFAR-10 test images — the true label is in the filename")
        with gr.Column(scale=1):
            scores_out = gr.Label(num_top_classes=5, label="All ten classes")
            detail_out = gr.Markdown()

    gr.Markdown(CAVEAT)

    provenance_rows = run_metrics_markdown()
    if provenance_rows:
        gr.Markdown("### The run that produced these weights\n\n"
                    "| | |\n|---|---|\n" + provenance_rows)

    go.click(predict, inputs=image_in, outputs=[scores_out, detail_out, gr.State()])
    image_in.change(predict, inputs=image_in, outputs=[scores_out, detail_out, gr.State()])

if __name__ == "__main__":
    demo.launch()
