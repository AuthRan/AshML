#!/usr/bin/env python3
"""Renders a terminal transcript to an animated GIF, for the README.

Why render rather than screen-record: the frames come from a *file of real output*, so
what a reader sees is exactly what the command printed, and re-running the command
reproduces it. A screen recording is a video of one person's terminal that nobody can
check. Everything these GIFs show was captured from a real run against the real cluster —
the input files are kept beside this script's invocation in the Makefile.

It is deliberately small: a fixed-width font, a palette matching the dashboard, and a
frame per line with a pause where the real command paused. No terminal emulator, no
dependency beyond Pillow, which is what makes it reproducible on a machine that has
neither asciinema nor vhs.

Colour comes from markers in the transcript rather than from ANSI codes, because the
transcripts are captured with `> file` and lose the codes anyway:

    @@ok@@      green      @@bad@@   red
    @@warn@@    amber      @@dim@@   grey
    @@head@@    blue       @@cmd@@   the prompt line

Usage:
    termgif.py transcript.txt out.gif [--cols 100] [--speed 1.0]
"""

import argparse
import re
import sys

from PIL import Image, ImageDraw, ImageFont

FONT = '/usr/share/fonts/truetype/jetbrains-mono-zorin-os/JetBrainsMono-Regular.ttf'
FALLBACK = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'

# The dashboard's palette, so the terminal and the web page look like one project.
BG, INK = '#0e1116', '#c9d1d9'
COLOURS = {
    'ok': '#3fb950', 'bad': '#f85149', 'warn': '#d29922',
    'dim': '#8b949e', 'head': '#58a6ff', 'cmd': '#e6edf3',
}
MARK = re.compile(r'@@(\w+)@@')

#: A line that starts a fresh screen. Sections, not scrolling — see `render`.
PAGE_BREAK = re.compile(r'^(Step \d|\$ |\s*(ok|FAIL)\s)').match

PAD, LEADING = 18, 6
CHROME = 30            # the title bar with its three dots


def parse(line):
    """Splits a line into (text, colour), stripping the markers."""
    m = MARK.search(line)
    if not m:
        return line, INK
    return MARK.sub('', line), COLOURS.get(m.group(1), INK)


def load(path):
    """Reads a transcript into (text, colour, hold) triples.

    A line ending in `@@pause@@` holds the frame — where the real command was waiting on
    a cluster, the GIF waits too, because a rollout that appears instant is a lie about
    what it costs.
    """
    rows = []
    for raw in open(path, encoding='utf-8').read().split('\n'):
        hold, keep = 1, False
        if raw.endswith('@@pause@@'):
            raw, hold = raw[:-len('@@pause@@')], 14
        if raw.endswith('@@keep@@'):
            # Stay on the current screen even though this line would start a new one.
            # Used so the run's *result* is still visible under the note that follows it,
            # which is the whole point of a GIF that ends on the result.
            raw, keep = raw[:-len('@@keep@@')], True
        text, colour = parse(raw)
        rows.append((text.rstrip(), colour, hold, keep))
    while rows and not rows[-1][0]:
        rows.pop()
    return rows


def render(rows, out, cols=100, speed=1.0, rows_visible=26, size=22):
    """Draws the transcript into a fixed viewport that scrolls, like a real terminal.

    A frame per line over a canvas tall enough for the whole transcript would make a GIF
    two thousand pixels high that no README can show; a viewport keeps it the shape of a
    terminal and keeps the file small enough to load on a phone.
    """
    try:
        font = ImageFont.truetype(FONT, size)
    except OSError:
        font = ImageFont.truetype(FALLBACK, size)

    cw = font.getlength('M')
    ch = size + LEADING
    width = int(cw * cols + PAD * 2)
    height = int(ch * rows_visible + PAD * 2 + CHROME)

    base = Image.new('RGB', (width, height), BG)
    d = ImageDraw.Draw(base)
    d.rectangle([0, 0, width, CHROME], fill='#161b22')
    for i, c in enumerate(('#f85149', '#d29922', '#3fb950')):
        cx, cy, r = PAD + 8 + i * 18, CHROME // 2, 5
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=c)
    d.text((PAD + 76, CHROME // 2 - size // 2 + 1), 'ashml', font=font, fill='#6e7681')

    # Where the screen starts again. A transcript that scrolled every line would make
    # every frame a full-canvas redraw, and a GIF nobody on a phone waits for; clearing at
    # each section keeps almost every frame a one-line difference, which is what lets the
    # encoder store almost nothing for it. It also reads the way the output reads.
    breaks, top = [], 0
    for i, (text, _, _, keep) in enumerate(rows):
        if PAGE_BREAK(text) and not keep and i - top > 2:
            top = i
        elif i - top >= rows_visible:
            top = i - rows_visible + 1
        breaks.append(top)

    frames, durations = [], []
    for i, (text, colour, hold, _) in enumerate(rows):
        window = rows[breaks[i]:i + 1]

        frame = base.copy()
        fd = ImageDraw.Draw(frame)
        for j, (t, c, *_ignored) in enumerate(window):
            fd.text((PAD, CHROME + PAD + j * ch), t, font=font, fill=c)

        last = len(window) - 1
        fd.rectangle([
            PAD + cw * len(window[last][0]), CHROME + PAD + last * ch + 3,
            PAD + cw * (len(window[last][0]) + 1), CHROME + PAD + last * ch + size,
        ], fill='#3b4351')

        frames.append(frame.convert('P', palette=Image.ADAPTIVE, colors=32))
        durations.append(int((90 if not text else 55) * hold / speed))

    durations[-1] = int(3400 / speed)
    frames[0].save(
        out, save_all=True, append_images=frames[1:],
        duration=durations, loop=0, optimize=True, disposal=1,
    )
    return width, height, len(frames)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('transcript')
    ap.add_argument('out')
    ap.add_argument('--cols', type=int, default=100)
    ap.add_argument('--speed', type=float, default=1.0)
    ap.add_argument('--rows', type=int, default=26)
    a = ap.parse_args()
    w, h, n = render(load(a.transcript), a.out, a.cols, a.speed, a.rows)
    print(f'{a.out}: {n} frames, {w}x{h}', file=sys.stderr)
