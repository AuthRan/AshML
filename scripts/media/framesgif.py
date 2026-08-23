#!/usr/bin/env python3
"""Assembles screenshot frames into a GIF, for the README.

The frames come from this machine's own Chrome in headless mode, pointed at a running
control plane — so the dashboard GIF is a recording of the real page against real state,
not a mock-up. Scaling and palette reduction happen here rather than in the browser so the
capture stays a faithful screenshot and only the encoding is lossy.

Usage:  framesgif.py 'dir/f*.png' out.gif [--width 1100] [--ms 260] [--crop TOP:BOTTOM]
"""

import argparse
import glob
import sys

from PIL import Image


def build(pattern, out, width=1100, ms=260, crop=None, colors=96):
    paths = sorted(glob.glob(pattern))
    if not paths:
        raise SystemExit(f'no frames matched {pattern}')

    frames = []
    for p in paths:
        im = Image.open(p).convert('RGB')
        if crop:
            top, bottom = crop
            im = im.crop((0, top, im.width, min(bottom, im.height)))
        if width and im.width != width:
            im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
        frames.append(im.convert('P', palette=Image.ADAPTIVE, colors=colors))

    durations = [ms] * len(frames)
    durations[-1] = max(ms, 2200)          # rest on the last state
    frames[0].save(
        out, save_all=True, append_images=frames[1:],
        duration=durations, loop=0, optimize=True, disposal=1,
    )
    print(f'{out}: {len(frames)} frames, {frames[0].width}x{frames[0].height}', file=sys.stderr)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('pattern')
    ap.add_argument('out')
    ap.add_argument('--width', type=int, default=1100)
    ap.add_argument('--ms', type=int, default=260)
    ap.add_argument('--crop', help='TOP:BOTTOM in source pixels')
    a = ap.parse_args()
    c = tuple(int(x) for x in a.crop.split(':')) if a.crop else None
    build(a.pattern, a.out, a.width, a.ms, c)
