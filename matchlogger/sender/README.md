# Station sender

Headless background process for a game PC. It watches the MatchLogger output
folder and forwards to the broker, stamping this machine's station number:

- new `sets/*.json` → `POST /matchlogger/ingest`
- changed `current.json` (the live heartbeat) → `POST /matchlogger/current`

Stations 2..N run only this — there's no UI here. The operator surface (web
console / Discord) lives elsewhere and reads the broker's aggregated view. See
[`../DESIGN.md`](../DESIGN.md).

## Requirements

Python 3.8+ (standard library only — no `pip install`). On a tournament PC it
can later be frozen to a single `.exe` with PyInstaller.

## Run

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

See [`config.example.json`](config.example.json). Command-line flags override
the config file, so the same config can be shared across stations with only
`--station N` differing.

### Useful flags

| Flag        | Effect                                                        |
| ----------- | ------------------------------------------------------------ |
| `--dry-run` | Print the requests instead of sending — verify wiring safely. |
| `--once`    | One pass then exit (testing, or a scheduled task).           |
| `--poll N`  | Seconds between passes (default 2).                          |
| `--state F` | State-file path (default `<dir>/.station-sender-state.json`). |
| `--key K`   | Station key — only needed if the broker has `STATION_KEY` set. |

## Corner widget (optional GUI)

`station_widget.py` is a small always-on-top window that runs the same sender
and lets you **set the station number** without editing the config, showing live
status (a green/red dot + the last action). Closing it sends it to the **system
tray** instead of quitting (the sender keeps running); the tray menu restores or
quits it.

```sh
python station_widget.py --config config.json
```

- Needs `tkinter` (bundled with Python on Windows/macOS). The tray fallback
  needs `pip install pystray pillow`; without them, closing just minimizes.
- The station number you set is written back into the config file.
- It's built to grow: `poll_extras()` returns the status rows under the sender
  line — wire it to obs-websocket to show "OBS: recording", etc. (there's a
  placeholder row there now).
- Everything else (broker, event slug, folder) still comes from the config,
  exactly like the headless sender — the widget is just a face on it.

## What it does and doesn't touch

- **Non-destructive.** It never modifies or deletes the MatchLogger files. A
  small state file (default in the watched folder) records which set files it
  has already sent and the last heartbeat it forwarded, so restarts don't
  re-send.
- **Resilient.** Network failures are retried on the next pass; a set file
  that's still being written (unparseable) is simply picked up once complete.
- **No secrets.** Only the broker URL, event slug, and station number — all
  non-sensitive. start.gg and Discord credentials live in the broker.
