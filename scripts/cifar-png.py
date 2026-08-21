#!/usr/bin/env python3
"""Writes CIFAR-10 *test* images out as PNGs, named with their true label.

This exists so that `ash predict` can be demonstrated — and checked — against images
whose answer is already known. A prediction on a photograph off the internet proves the
path works; a prediction on `test-00042-ship.png` proves the path works *and* carries the
model that was evaluated, because the label is in the filename and the accuracy is on
record.

    scripts/cifar-png.py --count 10 --out data/cifar-png
    ash predict resnet18-cifar10 --image data/cifar-png/test-00042-ship.png

Test images, never training ones: the deployed model was fitted on the training set, so
predicting on it would report memorisation as accuracy. Images are taken in file order
rather than sampled, so the same command twice gives the same files.

Standard library only — pickle, zlib, struct, tarfile. This is a script beside a dataset,
not part of the platform, and it should run on a machine with nothing installed. The PNGs
it writes are 32x32 truecolour with no filtering, which is the simplest thing that is a
valid PNG.
"""

import argparse
import pickle
import struct
import sys
import tarfile
import zlib
from pathlib import Path

LABELS = (
    "airplane", "automobile", "bird", "cat", "deer",
    "dog", "frog", "horse", "ship", "truck",
)


def load_test_batch(data_dir: Path):
    """Reads the test batch, from the extracted directory or from the archive.

    Both, because the extracted copy is what the image build leaves behind and the
    archive is what `scripts/fetch-cifar10.sh` verified a sha256 for. Falling back to the
    archive means this works on a checkout where only the tarball survived.
    """
    extracted = data_dir / "cifar-10-batches-py" / "test_batch"
    if extracted.exists():
        with extracted.open("rb") as handle:
            return pickle.load(handle, encoding="bytes")

    archive = data_dir / "cifar-10-python.tar.gz"
    if not archive.exists():
        raise SystemExit(
            f"no CIFAR-10 test data under {data_dir}: run `make cifar10` first"
        )
    with tarfile.open(archive) as tar:
        member = tar.extractfile("cifar-10-batches-py/test_batch")
        if member is None:
            raise SystemExit(f"{archive} has no cifar-10-batches-py/test_batch")
        return pickle.load(member, encoding="bytes")


def png_bytes(rgb: bytes, width: int = 32, height: int = 32) -> bytes:
    """Encodes flat RGB into a PNG. No filtering: 3 KB does not need compressing well."""

    def chunk(kind: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + kind
            + payload
            + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
        )

    raw = b"".join(
        b"\x00" + rgb[y * width * 3:(y + 1) * width * 3] for y in range(height)
    )
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", default="data", type=Path, help="where CIFAR-10 lives")
    parser.add_argument("--out", default="data/cifar-png", type=Path, help="where to write PNGs")
    parser.add_argument("--count", type=int, default=10, help="how many images")
    parser.add_argument(
        "--indices",
        help="comma-separated positions in the test set, instead of the first --count",
    )
    args = parser.parse_args()

    batch = load_test_batch(args.data)
    # CIFAR's python pickles are keyed by bytes, and each row is 3072 values stored
    # plane by plane: all 1024 reds, then greens, then blues.
    planes = batch[b"data"]
    labels = batch[b"labels"]

    if args.indices:
        wanted = [int(part) for part in args.indices.split(",") if part.strip()]
    else:
        wanted = list(range(min(args.count, len(labels))))

    args.out.mkdir(parents=True, exist_ok=True)
    for index in wanted:
        if not 0 <= index < len(labels):
            raise SystemExit(f"index {index} is outside the test set (0..{len(labels) - 1})")
        row = planes[index]
        red, green, blue = row[0:1024], row[1024:2048], row[2048:3072]
        rgb = bytes(
            value
            for pixel in range(1024)
            for value in (red[pixel], green[pixel], blue[pixel])
        )

        name = f"test-{index:05d}-{LABELS[labels[index]]}.png"
        (args.out / name).write_bytes(png_bytes(rgb))
        print(args.out / name)

    return 0


if __name__ == "__main__":
    sys.exit(main())
