# MatchLogger

A UE4SS mod that logs per-match and per-set stats from Rivals of Aether II,
and the tooling to tie it into a live tournament (start.gg + the
[VOD splitter](../vods/) + Discord).

- **[`ue4ss/`](ue4ss/)** — the mod and a minimal UE4SS profile tuned so it
  doesn't lag the game. Drop-in install for a game PC; see
  [`ue4ss/README.md`](ue4ss/README.md).
- **[`sender/`](sender/)** — the per-station sender that forwards the mod's
  output to the broker, run on **every** station PC — usually as the corner
  widget (`station_widget.py`), which is where you set the machine's station
  number; `station_sender.py` is the same sender headless.
- **Console (optional)** — `index.html` + `matchlogger.js/.css`, served at
  `/matchlogger/`. A debug view of the broker's aggregated state: live "now
  playing" per station and a sets-today table, reading `/matchlogger/event`.
  Nothing depends on it being open — day to day the operator administrates
  the bracket on start.gg itself and opens this page only to check what the
  MatchLogger pipeline is doing.
- **[`DESIGN.md`](DESIGN.md)** — how these fit together with the broker
  (`../broker/worker.js`) to aggregate every station's results and (once
  start.gg write access is added) report them.

## Status

Built: the mod, the sender, the broker endpoints (`/matchlogger/*`,
`/startgg/station`, KV-backed), the console, and passcode-gated reporting
(operator enters a passcode; the Worker verifies it before writing). The actual
start.gg bracket write activates once the broker has a `STARTGG_TOKEN`. Not yet
built: the Discord `/report` slash command. See the phasing section of
`DESIGN.md`.
