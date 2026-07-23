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
  --station 3 \
  --dir    "C:/Program Files (x86)/Steam/steamapps/common/RivalsofAether2/Rivals2/Binaries/Win64/MatchLogger"
```

Or put the stable values in a config file and pass just `--config`:

```sh
python station_sender.py --config config.json
```

See [`config.example.json`](config.example.json) — the same file the widget
writes. Command-line flags override the config file, so the same config can be
shared across stations with only `--station N` differing.

### Useful flags

| Flag        | Effect                                                        |
| ----------- | ------------------------------------------------------------ |
| `--dry-run` | Print the requests instead of sending — verify wiring safely. |
| `--once`    | One pass then exit (testing, or a scheduled task).           |
| `--poll N`  | Seconds between passes (default 2).                          |
| `--state F` | State-file path (default `<dir>/.station-sender-state.json`). |
| `--key K`   | Station key — only needed if the broker has `STATION_KEY` set. |

## Corner widget

`station_widget.py` is a small window that runs the same sender — a normal
window that just spawns in the bottom-right corner of the desktop.
It shows live status (a green/red dot + the last action) and has two
collapsible panels:

- **Settings** — every sender option (broker, event slug, station number,
  MatchLogger folder, optional station key), written back to `config.json` on
  Save. Opens automatically when anything required is missing, so a fresh
  install configures itself entirely in the widget.
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
- **No secrets.** Only the broker URL, event slug, and station number — all
  non-sensitive. start.gg and Discord credentials live in the broker.
