"""ResNet-18 on CIFAR-10. A real training run, reported through AshML.

Unlike `sdk_smoke.py`, this actually trains: real convolutions over real images, and
every number it reports is measured. What it is *not* is a benchmark. Read the caveats
this script prints at startup before quoting anything it produces — in particular, on a
host without GPU passthrough it trains on CPU, and a run bounded by `MAX_STEPS` is
undertrained by construction. Both are stated in the run's own output and in its
artifact metadata, because a number that travels without its conditions eventually gets
quoted as if it had none (spec Rule 5).

The model is the standard CIFAR variant of ResNet-18: torchvision's architecture with a
3x3 stride-1 stem and no max-pool. ImageNet's 7x7 stride-2 stem throws away most of a
32x32 image before the first residual block, which is why the CIFAR literature does not
use it.

    ash job submit examples/training/resnet-cifar.yaml --experiment <id>
"""

import json
import os
import random
import tempfile
import time

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import DataLoader
import torchvision
import torchvision.transforms as transforms

import ashml


def env_int(name, default):
    return int(os.environ.get(name, default))


def env_float(name, default):
    return float(os.environ.get(name, default))


EPOCHS = env_int("EPOCHS", 1)
BATCH_SIZE = env_int("BATCH_SIZE", 128)
LR = env_float("LR", 0.1)
MOMENTUM = env_float("MOMENTUM", 0.9)
WEIGHT_DECAY = env_float("WEIGHT_DECAY", 5e-4)
SEED = env_int("SEED", 1337)
DATA_DIR = os.environ.get("DATA_DIR", "/data")
LOG_EVERY = env_int("LOG_EVERY", 10)

#: Bounds a run so it finishes in demo time on CPU. 0 means a full epoch.
#: A run that stops here is undertrained, and says so everywhere it reports.
MAX_STEPS = env_int("MAX_STEPS", 0)

#: Bounds evaluation the same way, for the same reason.
MAX_EVAL_BATCHES = env_int("MAX_EVAL_BATCHES", 0)

CIFAR10_MEAN = (0.4914, 0.4822, 0.4465)
CIFAR10_STD = (0.2470, 0.2435, 0.2616)


def build_model() -> nn.Module:
    """ResNet-18, adapted for 32x32 inputs.

    Weights are random: this trains from scratch, so nothing is downloaded and the seed
    below is the whole of what determines the starting point.
    """
    model = torchvision.models.resnet18(weights=None, num_classes=10)
    model.conv1 = nn.Conv2d(3, 64, kernel_size=3, stride=1, padding=1, bias=False)
    model.maxpool = nn.Identity()
    return model


def seed_everything(seed: int) -> None:
    """Makes the run repeatable, which is the point of recording a seed at all.

    `use_deterministic_algorithms` is deliberately not set: it makes some convolutions
    much slower and raises on kernels that have no deterministic implementation. Seeding
    gives repeatability of the data order and the initialisation, which is what the
    experiment record claims — nothing here claims bit-exact reproducibility across
    hardware.
    """
    random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)


def loaders():
    train_transform = transforms.Compose([
        transforms.RandomCrop(32, padding=4),
        transforms.RandomHorizontalFlip(),
        transforms.ToTensor(),
        transforms.Normalize(CIFAR10_MEAN, CIFAR10_STD),
    ])
    eval_transform = transforms.Compose([
        transforms.ToTensor(),
        transforms.Normalize(CIFAR10_MEAN, CIFAR10_STD),
    ])

    # download=False on purpose. The dataset must already be in the image or mounted:
    # a training job that reaches out to the public internet mid-run is one whose data
    # can change underneath a recorded experiment.
    train = torchvision.datasets.CIFAR10(DATA_DIR, train=True, download=False, transform=train_transform)
    test = torchvision.datasets.CIFAR10(DATA_DIR, train=False, download=False, transform=eval_transform)

    workers = env_int("DATALOADER_WORKERS", 2)
    return (
        DataLoader(train, batch_size=BATCH_SIZE, shuffle=True, num_workers=workers, drop_last=True),
        DataLoader(test, batch_size=256, shuffle=False, num_workers=workers),
    )


@torch.no_grad()
def evaluate(model, loader, device):
    """Top-1 accuracy and mean loss over the test set."""
    model.eval()
    correct = total = 0
    loss_sum = 0.0

    for index, (images, labels) in enumerate(loader):
        if MAX_EVAL_BATCHES and index >= MAX_EVAL_BATCHES:
            break
        images, labels = images.to(device), labels.to(device)
        logits = model(images)
        loss_sum += F.cross_entropy(logits, labels, reduction="sum").item()
        correct += (logits.argmax(1) == labels).sum().item()
        total += labels.size(0)

    model.train()
    return (correct / total if total else 0.0), (loss_sum / total if total else 0.0)


def describe_device():
    """What this run actually got, reported rather than assumed."""
    if torch.cuda.is_available():
        return torch.device("cuda"), {
            "device": "cuda",
            "gpus": torch.cuda.device_count(),
            "name": torch.cuda.get_device_name(0),
            "cuda": torch.version.cuda,
        }
    return torch.device("cpu"), {
        "device": "cpu",
        "gpus": 0,
        "threads": torch.get_num_threads(),
    }


def main() -> None:
    seed_everything(SEED)
    device, hardware = describe_device()

    caveats = []
    if hardware["device"] == "cpu":
        caveats.append("trained on CPU; timings are not comparable to a GPU run")
    if MAX_STEPS:
        caveats.append(f"stopped at MAX_STEPS={MAX_STEPS}; the model is undertrained")
    if MAX_EVAL_BATCHES:
        caveats.append(f"evaluated on {MAX_EVAL_BATCHES} batches, not the full test set")

    print(f"[resnet] ResNet-18 / CIFAR-10, seed={SEED}, batch={BATCH_SIZE}, lr={LR}", flush=True)
    print(f"[resnet] device: {json.dumps(hardware)}", flush=True)
    for caveat in caveats:
        print(f"[resnet] CAVEAT: {caveat}", flush=True)
    if not caveats:
        print("[resnet] full run: no step or evaluation limits applied", flush=True)

    train_loader, test_loader = loaders()

    model = build_model().to(device)
    optimizer = torch.optim.SGD(
        model.parameters(), lr=LR, momentum=MOMENTUM, weight_decay=WEIGHT_DECAY, nesterov=True,
    )
    total_steps = MAX_STEPS or (len(train_loader) * EPOCHS)
    scheduler = torch.optim.lr_scheduler.OneCycleLR(optimizer, max_lr=LR, total_steps=total_steps)

    with ashml.init() as run:
        print(f"[resnet] reporting to job {run.job_id}", flush=True)

        step = 0
        started = time.monotonic()

        for epoch in range(EPOCHS):
            for images, labels in train_loader:
                images, labels = images.to(device), labels.to(device)

                optimizer.zero_grad(set_to_none=True)
                logits = model(images)
                loss = F.cross_entropy(logits, labels)
                loss.backward()
                optimizer.step()
                if step + 1 < total_steps:
                    scheduler.step()

                if step % LOG_EVERY == 0:
                    batch_accuracy = (logits.argmax(1) == labels).float().mean().item()
                    run.log_metrics(
                        {
                            "loss": loss.item(),
                            "train_accuracy": batch_accuracy,
                            "lr": scheduler.get_last_lr()[0],
                            "steps_per_second": (step + 1) / (time.monotonic() - started),
                        },
                        step=step,
                        epoch=epoch,
                    )
                    print(f"[resnet] step {step} loss {loss.item():.4f} acc {batch_accuracy:.3f}", flush=True)

                step += 1
                if MAX_STEPS and step >= MAX_STEPS:
                    break

            accuracy, val_loss = evaluate(model, test_loader, device)
            run.log_metrics({"val_accuracy": accuracy, "val_loss": val_loss}, step=step, epoch=epoch)
            print(f"[resnet] epoch {epoch}: val_accuracy {accuracy:.4f} val_loss {val_loss:.4f}", flush=True)

            checkpoint = save(model, optimizer, step, epoch)
            try:
                run.log_artifact(
                    checkpoint,
                    name=f"epoch-{epoch}.pt",
                    kind="checkpoint",
                    step=step,
                    metadata={"epoch": epoch, "val_accuracy": accuracy, **caveat_metadata(caveats, hardware)},
                )
            finally:
                os.unlink(checkpoint)

            if MAX_STEPS and step >= MAX_STEPS:
                break

        final = save(model, optimizer, step, EPOCHS - 1, weights_only=True)
        try:
            artifact = run.log_artifact(
                final,
                name="resnet18-cifar10.pt",
                kind="model",
                step=step,
                metadata={
                    "architecture": "resnet18-cifar",
                    "val_accuracy": accuracy,
                    "steps": step,
                    "seed": SEED,
                    **caveat_metadata(caveats, hardware),
                },
            )
        finally:
            os.unlink(final)

        elapsed = time.monotonic() - started
        print(f"[resnet] done in {elapsed:.1f}s: {step} steps, val_accuracy {accuracy:.4f}", flush=True)
        print(f"[resnet] model artifact {artifact.id} ({artifact.status}, verified={artifact.verified})", flush=True)
        for caveat in caveats:
            print(f"[resnet] CAVEAT: {caveat}", flush=True)


def caveat_metadata(caveats, hardware):
    """Caveats travel with the artifact.

    A checkpoint outlives the log that explained it, and someone will find this file in
    six months. Whatever qualifies its accuracy has to be attached to the thing itself.
    """
    return {"caveats": caveats, "hardware": hardware, "benchmark": False}


def save(model, optimizer, step, epoch, *, weights_only=False):
    handle = tempfile.NamedTemporaryFile(delete=False, suffix=".pt")
    handle.close()

    payload = {"model": model.state_dict(), "step": step, "epoch": epoch, "seed": SEED}
    if not weights_only:
        # A resumable checkpoint needs the optimizer; a published model does not, and
        # shipping SGD momentum buffers to an inference server is just weight.
        payload["optimizer"] = optimizer.state_dict()

    torch.save(payload, handle.name)
    return handle.name


if __name__ == "__main__":
    main()
