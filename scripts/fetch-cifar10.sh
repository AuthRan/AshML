#!/bin/bash
# Fetches and verifies the CIFAR-10 python archive for the Phase 4 training image.
#
# The dataset is baked into the training image rather than downloaded by the job, so
# that `download=False` in the workload is a guarantee rather than a hope: a run that
# fetches from the public internet mid-training is one whose data can change underneath
# a recorded experiment.
#
#   scripts/fetch-cifar10.sh [dest-dir]        # default: ./data
#
# Leaves <dest>/cifar-10-batches-py ready to be passed to the image build. Idempotent:
# if the extracted data is already there and checksums clean, it does nothing.
#
# Two things here are deliberate and worth not "simplifying" away.
#
# The URL is the redirect *target*. www.cs.toronto.edu answers 301 to cave.cs.toronto.edu,
# and a ranged request that follows that redirect comes back 200 with a full body rather
# than 206 with a range. `curl -C -` then appends the full body onto the partial file,
# which produces a file *larger* than the real 170498071 bytes and fails its checksum
# after a long download. Requesting the final URL directly keeps ranges working.
#
# The download is chunked and parallel. Single-connection throughput from this host is
# ~55 KB/s while six concurrent connections reach ~450 KB/s, so the limit is per
# connection rather than the link — serially this takes 50 minutes and in parallel it
# takes 6. Each chunk is checked for both a 206 status and its exact expected length
# before it counts, so a short read can never be mistaken for progress.
set -euo pipefail

DEST="${1:-data}"
URL="https://cave.cs.toronto.edu/kriz/cifar-10-python.tar.gz"
TOTAL=170498071
WANT_SHA=6d958be074577803d12ecdefd02955f39262c83c16fe9348329d7fe0b5c001ce
CHUNK=$((4 * 1024 * 1024))
JOBS=6

mkdir -p "$DEST"
ARCHIVE="$DEST/cifar-10-python.tar.gz"
PARTS="$DEST/.cifar-parts"

# The five training batches, the test batch and the label names. If they are all here
# the work is done; torchvision checks their md5s itself on load.
if [ -f "$DEST/cifar-10-batches-py/test_batch" ] && [ -f "$DEST/cifar-10-batches-py/batches.meta" ]; then
  echo "cifar-10: already extracted at $DEST/cifar-10-batches-py"
  exit 0
fi

verify_archive() {
  [ -f "$ARCHIVE" ] || return 1
  [ "$(stat -c %s "$ARCHIVE")" = "$TOTAL" ] || return 1
  [ "$(sha256sum "$ARCHIVE" | cut -d' ' -f1)" = "$WANT_SHA" ] || return 1
}

if verify_archive; then
  echo "cifar-10: archive already present and verified"
else
  echo "cifar-10: fetching $TOTAL bytes in $JOBS parallel streams"
  mkdir -p "$PARTS"
  NCHUNKS=$(((TOTAL + CHUNK - 1) / CHUNK))

  chunk_end() {
    local end=$(($1 + CHUNK - 1))
    [ $end -ge $TOTAL ] && end=$((TOTAL - 1))
    echo $end
  }

  fetch_chunk() {
    local n=$1
    local start=$((n * CHUNK))
    local end want part have code
    end=$(chunk_end $start)
    want=$((end - start + 1))
    part="$PARTS/part.$(printf %04d "$n")"
    for _ in $(seq 1 30); do
      have=$(stat -c %s "$part" 2>/dev/null || echo 0)
      [ "$have" = "$want" ] && return 0
      code=$(curl -s --max-time 150 -r "${start}-${end}" -o "$part" -w '%{http_code}' "$URL" 2>/dev/null || echo 000)
      have=$(stat -c %s "$part" 2>/dev/null || echo 0)
      if [ "$code" = "206" ] && [ "$have" = "$want" ]; then
        return 0
      fi
      rm -f "$part"
      sleep 3
    done
    echo "cifar-10: chunk $n failed after 30 attempts" >&2
    return 1
  }

  running=0
  for n in $(seq 0 $((NCHUNKS - 1))); do
    fetch_chunk "$n" &
    running=$((running + 1))
    if [ $running -ge $JOBS ]; then
      wait -n
      running=$((running - 1))
    fi
  done
  wait

  for n in $(seq 0 $((NCHUNKS - 1))); do
    start=$((n * CHUNK))
    end=$(chunk_end $start)
    want=$((end - start + 1))
    have=$(stat -c %s "$PARTS/part.$(printf %04d "$n")" 2>/dev/null || echo 0)
    if [ "$have" != "$want" ]; then
      echo "cifar-10: chunk $n incomplete ($have/$want bytes)" >&2
      exit 1
    fi
  done

  cat "$PARTS"/part.* > "$ARCHIVE"
  rm -rf "$PARTS"

  if ! verify_archive; then
    echo "cifar-10: checksum failed — refusing to extract" >&2
    echo "  expected sha256 $WANT_SHA" >&2
    echo "  got      sha256 $(sha256sum "$ARCHIVE" | cut -d' ' -f1)" >&2
    exit 1
  fi
  echo "cifar-10: verified sha256 $WANT_SHA"
fi

tar -xzf "$ARCHIVE" -C "$DEST"
echo "cifar-10: extracted to $DEST/cifar-10-batches-py"
