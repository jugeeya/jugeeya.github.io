# MatchLogger

A UE4SS mod that logs per-match and per-set stats from Rivals of Aether II,
and the tooling to tie it into a live tournament (start.gg + the
[VOD splitter](../vods/) + Discord).

- **[`ue4ss/`](ue4ss/)** — the mod and a minimal UE4SS profile tuned so it
  doesn't lag the game. Drop-in install for a game PC; see
  [`ue4ss/README.md`](ue4ss/README.md).
- **[`sender/`](sender/)** — the per-station sender that forwards the mod's
  output to the broker, run on **every** station PC — usually as the corner
  widget (`rivals-station-reporter.pyw` / `station_widget.py`), which is where
  you set the machine's station number and the shared key; `station_sender.py`
  is the same sender headless. The shared key is **required** — it's the same
  value as the broker's `OPERATOR_KEY`, since it authorizes the automatic live
  per-game score push (see below).
- **Console (optional)** — `index.html` + `matchlogger.js/.css`, served at
  `/matchlogger/`. A debug view of the broker's aggregated state: live "now
  playing" per station and a sets-today table, reading `/matchlogger/event`.
  Nothing depends on it being open for the live-score part, but **reporting
  the winner of a set always happens here (or in Discord)** — no set finalizes
  itself.
- **[`DESIGN.md`](DESIGN.md)** — how these fit together with the broker
  (`../broker/worker.js`) to aggregate every station's results and report them.

## Status

Built: the mod, the sender/widget, the broker endpoints (`/matchlogger/*`,
`/startgg/station`, KV-backed), the console, and **automatic live scoring** —
`/matchlogger/live` streams each set's running per-game score and characters
to start.gg with no human involved, since it can't advance the bracket by
itself. **Finalizing a set (naming the winner) always stays a manual click**
in the console or Discord, at any match confidence — ingest only computes a
candidate to pre-fill that click, never reports on its own. Everything is
gated by one required shared key (`OPERATOR_KEY`) that every station and the
console/Discord all use. Not yet built: the Discord `/report` slash command.
See the phasing section of `DESIGN.md`.
