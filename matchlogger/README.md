# MatchLogger

A UE4SS mod that logs per-match and per-set stats from Rivals of Aether II,
and the tooling to tie it into a live tournament (start.gg + the
[VOD splitter](../vods/) + Discord).

- **[`ue4ss/`](ue4ss/)** — the mod and a minimal UE4SS profile tuned so it
  doesn't lag the game. Drop-in install for a game PC; see
  [`ue4ss/README.md`](ue4ss/README.md).
- **[`DESIGN.md`](DESIGN.md)** — how the mod, a headless per-station sender,
  the broker (`../broker/worker.js`), and a browser operator console fit
  together to aggregate every station's results and (optionally) report them
  to start.gg.
- **`sender/`, and the console page** — to be built (see the phasing section
  of the design doc).
