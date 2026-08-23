# What the GIFs are made of

Each `.txt` here is the **captured output of a real run** against the real k3d cluster,
with colour markers added and long lines wrapped. Nothing in them was retyped, and no
number in them was edited — which is the point: a reader can diff a GIF against the file
that produced it, and reproduce the file by running the command in its first line.

`scripts/media/termgif.py` renders one into an animated terminal; `make media` rebuilds
all of them. The markers are documented in that script's header — `@@ok@@`, `@@dim@@`,
`@@pause@@` and so on — and are the only thing added to the raw output.

The dashboard GIF has no transcript because it is not text: it is a sequence of
screenshots taken by this machine's own Chrome, headless, pointed at a running control
plane. `scripts/media/framesgif.py` assembles them.

**If you change one of these files, you are changing what the README claims a run
printed.** Re-run the command and re-capture instead.
