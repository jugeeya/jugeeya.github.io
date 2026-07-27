# Rivals Station Reporter (station sender)

Background process for a game PC. It watches the MatchLogger output folder and
forwards to the broker, stamping this machine's station number:

- new `sets/*.json` → `POST /matchlogger/ingest`
- changed `current.json` (the live heartbeat) → `POST /matchlogger/current`
- changed `live.json` (running per-game score) → `POST /matchlogger/live`

**Every station PC runs one** — usually as the corner widget below, where all
of its settings live (no config-file editing). Administration happens on
start.gg itself;
the [web console](../) is an optional debug view of the broker's aggregated
state if you need to check what's flowing. See [`../DESIGN.md`](../DESIGN.md).

The packaged download (`rivals-station-reporter.zip`, from the console's
install button) unpacks to just one launcher plus an `_internal/` folder
holding everything below — so there's only one file to find and double-click.
This directory holds the flat source the zip is built from (see
`.github/workflows/build-matchlogger-dist.yml`); running things directly from
here during development works the same way, since the launcher falls back to
importing its sibling files when there's no `_internal/` next to it.

## Requirements

Python 3.8+ (standard library only — no `pip install`). On a tournament PC it
can later be frozen to a single `.exe` with PyInstaller.

## Run — the widget (what station PCs use)

- **Windows:** double-click **`rivals-station-reporter.pyw`** — no terminal
  window opens; the widget's **Log** panel shows what would have been printed
  there.
- Anywhere else: `python rivals-station-reporter.pyw` (or `station_widget.py`
  directly if you're working in this flat source folder rather than the
  packaged zip).

No config file editing needed: on first run the widget opens its **Settings**
panel — broker URL, start.gg event slug, station number, and the MatchLogger
output folder (with a folder picker) — and **Save** writes them to
`config.json` next to the script, so the next launch needs nothing. See
"Corner widget" below for the rest of what it does.

## Run — headless (no window at all)

For a scheduled task, or when you'd rather pass everything on the command
line. In the packaged zip this file lives in `_internal/` — `cd` there first.

```sh
python station_sender.py \
  --broker https://r2tag-broker.jdsambasivam.workers.dev \
  --slug   tournament/your-tournament/event/your-event \
  --station 3 --key "<same value as the broker's OPERATOR_KEY secret>" \
  --dir    "C:/Program Files (x86)/Steam/steamapps/common/RivalsofAether2/Rivals2/Binaries/Win64/MatchLogger"
```

Or put the stable values in a config file and pass just `--config`:

```sh
python station_sender.py --config config.json
```

See [`config.example.json`](config.example.json) — the same file the widget
writes. Command-line flags override the config file, so the same config can be
shared across stations with only `--station N` differing.

`--key` is required — it's the same value as the broker's `OPERATOR_KEY`
secret, not a separate one. Every set this sender submits gets its running
per-game score pushed to start.gg automatically (no human involved), so this
key is a real bracket-write credential, not just a submission password —
treat it accordingly. It does **not** let this station finalize a set on its
own: naming a winner always requires an explicit click in the console or
Discord (see the console's report behavior below), regardless of how
confident the match is.

### Useful flags

| Flag        | Effect                                                        |
| ----------- | ------------------------------------------------------------ |
| `--dry-run` | Print the requests instead of sending — verify wiring safely. |
| `--once`    | One pass then exit (testing, or a scheduled task).           |
| `--poll N`  | Seconds between passes (default 2).                          |
| `--state F` | State-file path (default `<dir>/.station-sender-state.json`). |
| `--key K`   | **Required to send.** Same value as the broker's `OPERATOR_KEY` secret. |
| `--source`  | `mod` (default) or `stats` — see below. |

## Stats-diff mode — no UE4SS mod (`--source stats`)

The sender can produce the MatchLogger files **itself**, without the mod (no
injection, no Easy-Anti-Cheat concern). Instead of watching a folder the mod
writes, it watches two things the game already writes:

- **`Rivals2_StatsSaveSlot.sav`** — the stats save, which flushes **per game, in
  real time**. Diffing it recovers the winner, loser, characters, and per-game
  stats (KOs, damage, parries, grabs, …). Parsed by
  [`rivals_stats.py`](rivals_stats.py) — a stdlib-only GVAS reader whose output
  matches the site's `uesave` wasm exactly.
- **`Saved/Replays/*.rpl`** — auto-saved every game; the *filename* gives the
  timestamp, `Player1/Player2` slots, characters, and the `GameN` set counter.

It writes the same `current.json` / `live.json` / `sets/*.json` into its own
`--dir` and then forwards them exactly as in mod mode — so the broker sees no
difference.

```sh
python station_sender.py --source stats \
  --broker https://r2tag-broker.jdsambasivam.workers.dev \
  --slug tournament/your-tournament/event/your-event \
  --station 1
  # --dir defaults to ./matchlogger-out (the sender's own working folder)
  # --save / --replays default to the standard %LOCALAPPDATA% paths
  # --idle SEC  finalize an open set after this many quiet seconds (default 420)
```

**Scope:** LOCAL brackets are the validated case — both players' tags update on
the one PC, so a single diff yields winner **and** loser. ONLINE fills the
opponent from the replay filename (no opponent stats). Trade-offs vs. the mod:
no frame-accurate match-start time (end times come from the replay) and
`winsRequired` is unknown (`null`) — the operator console confirms before any
start.gg write anyway. Tests: `python test_rivals_stats.py [save.sav]`.

Runs **without a bracket**: with no `--broker`/`--slug` it just produces the
files + scoreboard locally (nothing is forwarded).

### Scoreboard

A live table of the sets it detects, in two forms:

- **Console** (`--source stats` in a terminal): redraws a table of
  `Time · Tag · start.gg · Character · Score`, winner starred.
- **GUI reporter** (double-click `rivals-station-reporter.pyw`): the same table
  in the corner window, winner in bold, live set marked — no terminal needed.

The **start.gg** column comes from `players.json` next to the script — a map of
save-tag to start.gg tag, e.g. `{"JUGZ!": "jugeeya", "KIM": "Kimchi"}`. Without
it that column shows `-`.

## LAN mode — run the event with no Cloudflare (`"mode": "operator"`)

At an event every machine is on one network, so per-game traffic doesn't need
to leave it. Set one PC to **operator** and it runs a local hub
([`hub.py`](hub.py)): stations POST to it, and it is the only machine that talks
to start.gg. Cloudflare is then out of the loop entirely — no KV reads, writes
or list ops, so none of the free-tier limits apply.

The hub speaks the **same `/matchlogger/*` API as the broker**, so a station
switches over by pointing its "Hub / broker URL" at the operator's address —
no other station changes.

| Mode | What the app does |
| --- | --- |
| `station` | Watches this PC's games and sends them onward (the default). |
| `operator` | Runs the LAN hub + shows the console view. No game watching. |
| `both` | This PC is a station *and* the operator (talks to its own hub). |

**Operator setup:** pick `operator` in the Mode box, put the **start.gg API
token** in Settings (it lives only here), and set the **shared key**. The window
then shows `hub: http://<your-lan-ip>:8787` — that's what every station puts in
its Hub URL box, with the same shared key. Windows will ask to allow the
listener through the firewall the first time; do that before the event.

**Console view.** In operator mode the table becomes the full console: every
station's sets with station number, both players' tags, the matched start.gg
entrant, character, score, bracket round, and status. Select a set to act on it:

- **Report winner…** — asks which entrant won (pre-marking the suggested one)
  and finalizes on start.gg. The only action that advances the bracket.
- **Switch winner** — the station paired the two players backwards; flips the
  mapping and immediately re-pushes the corrected live score.
- **Delete** — drops the set from the console. start.gg is never touched.

Per-game scores still go to start.gg **automatically** as games finish
(non-advancing: no winner is set), exactly as through the broker.

### Nothing touches the bracket until you press Start Match

A set is only bound to a start.gg set once that set is **ongoing** — i.e. the TO
pressed **Start Match**. A match merely called to a station still counts as
warmups: it's recorded and shown as `waiting for start`, but it isn't bound,
isn't pushed to the live score, and can't be reported. The app also never calls
`markSetInProgress`, so it can't start a match on its own.

If a set finishes before you press Start Match, hitting **Report** afterwards
re-checks start.gg and binds it then, so nothing is lost.

### Switch players

The station can only guess who's who — in-game tags don't have to match start.gg
tags, and it reports *something* rather than nothing. When the game count and
characters make the real pairing obvious, **Switch players** flips which in-game
player is which start.gg entrant. Characters and the live score are re-pushed
immediately, and the pairing is **remembered** (in `learned-tags.json`, kept
separate so a hand-written `players.json` is never rewritten) — so the next set
between the same people maps correctly without another correction.

### Online and ranked games

People play the ladder at a station between tournament matches, and the stats
save records those too. Only **LOCAL** games — two people on the same machine —
are tournament sets. Online and ranked games are still logged and shown (greyed
out, labelled `online` / `ranked`, with "not a bracket set" where the round
would be), but they are never bound to the station's start.gg set, never pushed
to the live score, and cannot be reported. Sets from the UE4SS mod carry no mode
field and stay reportable exactly as before.

Tests: `python test_matching.py` and `python test_hub.py` (the latter runs a
real hub and drives it with the real station sender; start.gg is stubbed).

## Corner widget

`station_widget.py` is a small window that runs the same sender — a normal
window that just spawns in the bottom-right corner of the desktop.
It shows live status (a green/red dot + the last action) and has two
collapsible panels:

- **Settings** — every sender option (broker, event slug, station number,
  MatchLogger folder, and the shared key — required), written back to
  `config.json` on Save. Opens automatically when anything required is
  missing, so a fresh install configures itself entirely in the widget.
- **Log** — the sender's recent log lines (the same ones the headless sender
  prints), so you never need a terminal to see what it's doing.

This is what each station PC runs at an event — set it up once and forget it.
Closing it sends it to the **system tray** instead of quitting (the sender
keeps running); the tray menu restores or quits it.

- On Windows, launch it by double-clicking `rivals-station-reporter.pyw` — the
  `.pyw` extension runs under `pythonw.exe`, which never opens a terminal
  window.
- Needs `tkinter` (bundled with Python on Windows/macOS). The tray fallback
  needs `pip install pystray pillow`; without them, closing just minimizes.
- It's built to grow: `poll_extras()` returns the status rows under the sender
  line — wire it to obs-websocket to show "OBS: recording", etc. (there's a
  placeholder row there now).

## What it does and doesn't touch

- **Non-destructive.** It never modifies or deletes the MatchLogger files. A
  small state file (default in the watched folder) records which set files it
  has already sent and the last heartbeat it forwarded, so restarts don't
  re-send.
- **Resilient.** Network failures are retried on the next pass; a set file
  that's still being written (unparseable) is simply picked up once complete.
- **Does hold one secret.** The shared key (same value as the broker's
  `OPERATOR_KEY`) — treat `config.json` as sensitive, not just as settings.
  The start.gg token and Discord credentials themselves still never leave the
  broker; the shared key only authorizes talking to it.
