# MatchLogger

A UE4SS mod that logs per-match and per-set stats from Rivals of Aether II,
and the tooling to tie it into a live tournament (start.gg + the
[VOD splitter](../vods/) + Discord).

- **[`ue4ss/`](ue4ss/)** — the mod and a minimal UE4SS profile tuned so it
  doesn't lag the game. Drop-in install for a game PC; see
  [`ue4ss/README.md`](ue4ss/README.md).
- **[`sender/`](sender/)** — the headless per-station sender that forwards the
  mod's output to the broker (`sender/station_sender.py`, stdlib-only).
- **Operator console** — `index.html` + `matchlogger.js/.css`, served at
  `/matchlogger/`. Live "now playing" per station and a sets-today table across
  all stations, reading the broker's `/matchlogger/event`.
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
