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

#: Upload a resumable checkpoint every N optimizer steps, on top of the one taken at
#: every epoch boundary. 0 keeps the epoch-only behaviour.
#:
#: This is the dial between two costs, and neither is negligible: what an interrupted
#: run loses is the work since its last checkpoint, and what a frequent checkpoint costs
#: is 85 MiB through the SDK's upload path while the GPU waits. An hour-long epoch with
#: epoch-only checkpoints can lose an hour. The right value depends on how long a step
#: takes and how often the cluster disrupts a pod, so it is a knob rather than a default.
CHECKPOINT_EVERY = env_int("CHECKPOINT_EVERY", 0)

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

    steps_per_epoch = len(train_loader)

    with ashml.init() as run:
        print(f"[resnet] reporting to job {run.job_id}", flush=True)

        # Nothing on a first attempt. On a retry, AshML offers the newest checkpoint it
        # confirmed exists, and this is where the run stops being a repetition.
        step, start_epoch = restore(run, model, optimizer, scheduler, device, caveats, steps_per_epoch)

        accuracy = None
        started = time.monotonic()
        started_at_step = step

        for epoch in range(start_epoch, EPOCHS):
            # A resumed epoch runs the batches it has left, not a whole one — otherwise
            # a run interrupted five times trains for five extra epochs and the step
            # count stops meaning anything.
            budget = steps_per_epoch - (step - epoch * steps_per_epoch)
            done_this_epoch = 0

            for images, labels in train_loader:
                if done_this_epoch >= budget:
                    break
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
                            # Measured over this attempt only. A resumed run's rate is
                            # not (steps so far / seconds since this process started),
                            # which would report a speed nothing ever ran at.
                            "steps_per_second": (step - started_at_step + 1) / (time.monotonic() - started),
                        },
                        step=step,
                        epoch=epoch,
                    )
                    print(f"[resnet] step {step} loss {loss.item():.4f} acc {batch_accuracy:.3f}", flush=True)

                step += 1
                done_this_epoch += 1

                if CHECKPOINT_EVERY and step % CHECKPOINT_EVERY == 0 and step < total_steps:
                    checkpoint = save(model, optimizer, step, epoch, scheduler=scheduler)
                    try:
                        run.log_artifact(
                            checkpoint,
                            name=f"step-{step}.pt",
                            kind="checkpoint",
                            step=step,
                            metadata={"epoch": epoch, "mid_epoch": True, **caveat_metadata(caveats, hardware)},
                        )
                        print(f"[resnet] checkpointed at step {step}", flush=True)
                    finally:
                        os.unlink(checkpoint)

                if MAX_STEPS and step >= MAX_STEPS:
                    break

            accuracy, val_loss = evaluate(model, test_loader, device)
            run.log_metrics({"val_accuracy": accuracy, "val_loss": val_loss}, step=step, epoch=epoch)
            print(f"[resnet] epoch {epoch}: val_accuracy {accuracy:.4f} val_loss {val_loss:.4f}", flush=True)

            checkpoint = save(model, optimizer, step, epoch, scheduler=scheduler)
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

        if accuracy is None:
            # Resumed past the last training step — an interruption between the final
            # epoch's checkpoint and the model upload. There is a model to publish and
            # no measurement of it, so measure it rather than publishing a number the
            # previous attempt happened to record.
            accuracy, val_loss = evaluate(model, test_loader, device)
            run.log_metrics({"val_accuracy": accuracy, "val_loss": val_loss}, step=step, epoch=EPOCHS - 1)
            print(f"[resnet] resumed run evaluated: val_accuracy {accuracy:.4f}", flush=True)

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


def save(model, optimizer, step, epoch, *, scheduler=None, weights_only=False):
    """Writes a checkpoint. Returns the path; the caller uploads and deletes it.

    ``step`` is the global count of optimizer steps completed, and it is what a resume
    is keyed on — the epoch is written for a reader, not for the arithmetic, because the
    epoch a step belongs to is `step // steps_per_epoch` and deriving it cannot drift
    from the step the way a second stored field can.
    """
    handle = tempfile.NamedTemporaryFile(delete=False, suffix=".pt")
    handle.close()

    payload = {"model": model.state_dict(), "step": step, "epoch": epoch, "seed": SEED}
    if not weights_only:
        # A resumable checkpoint needs the optimizer; a published model does not, and
        # shipping SGD momentum buffers to an inference server is just weight.
        payload["optimizer"] = optimizer.state_dict()
        # And the schedule. Without it a resumed run restarts OneCycle from its warm-up
        # at whatever step it resumed at, which is a different learning-rate schedule
        # from the one the experiment recorded — the loss recovers and the run looks
        # fine, so this is exactly the kind of wrongness nothing reports.
        if scheduler is not None:
            payload["scheduler"] = scheduler.state_dict()

    torch.save(payload, handle.name)
    return handle.name


def restore(run, model, optimizer, scheduler, device, caveats, steps_per_epoch):
    """Loads the checkpoint AshML offered this attempt. Returns `(step, epoch)`.

    `(0, 0)` on a first attempt, which is every attempt that was not retried.

    What is restored is the model, the optimizer's moments and the learning-rate
    schedule. What is **not** restored is the position in the shuffled training set: the
    resumed epoch runs the number of batches it had left, drawn fresh, rather than the
    exact images the killed attempt had not reached. Replaying those would mean
    checkpointing the sampler's state and the RNG alongside the weights, and this run
    does not, so the honest thing is to say so — it goes in the caveats, which travel
    with every artifact the resumed attempt produces.
    """
    path = run.fetch_resume()
    if path is None:
        return 0, 0

    try:
        # weights_only=True: this file arrived over the network, and torch.load is a
        # pickle loader. The bytes were verified against the digest AshML recorded, but
        # that proves they are the bytes we uploaded, not that executing them is safe —
        # and a training pod that can be made to execute arbitrary pickles by a
        # substituted checkpoint is a much worse failure than a lost run.
        state = torch.load(path, map_location=device, weights_only=True)
    finally:
        os.unlink(path)

    # strict=True on purpose. A checkpoint whose keys do not match this architecture is
    # a checkpoint from a different model, and loading the half of it that fits produces
    # a network that trains without ever recovering.
    model.load_state_dict(state["model"], strict=True)
    optimizer.load_state_dict(state["optimizer"])
    if "scheduler" in state:
        scheduler.load_state_dict(state["scheduler"])

    step = int(state["step"])
    epoch = step // steps_per_epoch
    print(
        f"[resnet] resuming from artifact {run.resume_artifact_id}: "
        f"step {step}, epoch {epoch}"
        + ("" if "scheduler" in state else " (no schedule in checkpoint; it restarts)"),
        flush=True,
    )
    added = [
        f"resumed from a checkpoint at step {step} after an interruption; the resumed "
        "epoch's remaining batches were drawn fresh rather than replayed, so the data "
        "order differs from an uninterrupted run"
    ]
    if "scheduler" not in state:
        added.append(
            "the checkpoint carried no learning-rate schedule, so the schedule restarted "
            "at the resumed step"
        )
    for caveat in added:
        print(f"[resnet] CAVEAT: {caveat}", flush=True)
    caveats.extend(added)

    return step, epoch


if __name__ == "__main__":
    main()
