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
  value as the broker's `OPERATOR_KEY`, since a submitted set can trigger an
  automatic bracket write (see below).
- **Console (optional)** — `index.html` + `matchlogger.js/.css`, served at
  `/matchlogger/`. A debug view of the broker's aggregated state: live "now
  playing" per station and a sets-today table, reading `/matchlogger/event`.
  Nothing depends on it being open — most sets report themselves; this page is
  for checking what the pipeline is doing and correcting the rare set that
  couldn't auto-report.
- **[`DESIGN.md`](DESIGN.md)** — how these fit together with the broker
  (`../broker/worker.js`) to aggregate every station's results and report them.

## Status

Built: the mod, the sender/widget, the broker endpoints (`/matchlogger/*`,
`/startgg/station`, KV-backed), the console, and **automatic reporting** —
ingest reports a set to start.gg immediately whenever it has any candidate
winner (exact or fuzzy name match), no human click needed. Manual report via
the console/Discord is the fallback only for the rare set with no name match
at all, or a failed auto-report attempt. Everything is gated by one required
shared key (`OPERATOR_KEY`) that every station and the console/Discord all use.
Not yet built: the Discord `/report` slash command. See the phasing section of
`DESIGN.md`.
