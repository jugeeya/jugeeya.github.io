#!/usr/bin/env python3
"""MatchLogger station sender — headless.

Watches a MatchLogger output folder on a game PC and forwards what it finds to
the broker, stamping this machine's station number on the way out:

  * new  <dir>/sets/*.json     -> POST <broker>/matchlogger/ingest
  * changed <dir>/current.json -> POST <broker>/matchlogger/current   (heartbeat)
  * changed <dir>/live.json    -> POST <broker>/matchlogger/live      (running score)

This is the core every station PC runs; station_widget.py wraps it with a
Settings/Log window. This file is the no-window variant — same behavior, run
from a terminal or a scheduled task instead. It DOES hold one secret — the
shared key below — since the running-score push (matchlogger/live) writes to
start.gg automatically, no human involved; it's the same value as the
broker's OPERATOR_KEY, not a separate lower-stakes one. It does NOT let this
station finalize a set on its own — naming a winner always requires an
explicit click in the console or Discord. The start.gg token itself still
never leaves the broker. Standard library only (no pip installs) so it
freezes cleanly into an .exe later.

Usage:
  python station_sender.py --broker https://r2tag-broker.jdsambasivam.workers.dev \
      --slug tournament/foo/event/bar --station 3 --key <shared key> \
      --dir "C:/.../Rivals2/Binaries/Win64/MatchLogger"

Flags of note:
  --key K     required: same value as the broker's OPERATOR_KEY secret
  --dry-run   print the requests instead of sending them
  --once      one pass then exit (for testing / cron-style use)
  --poll N    seconds between passes (default 2)
  --config F  JSON file with any of {broker, slug, station, dir, key, poll};
              explicit command-line flags win over it.
"""

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

STATE_VERSION = 1

# Optional sink so the stats-mode dashboard can capture log lines instead of
# printing them (it owns the screen). Left None -> plain stdout.
_log_hook = None


def log(msg):
    if _log_hook is not None:
        _log_hook(msg)
    else:
        print(f"[station-sender] {msg}", flush=True)


def normalize_slug(slug):
    """Reduce a pasted start.gg event/bracket URL to the broker's event slug.

    The broker wants exactly `tournament/<t>/event/<e>`. People naturally paste
    the whole URL (with https://www.start.gg/ and a trailing /brackets/… path),
    so pull the tournament+event pair out of whatever they gave us.
    """
    import re
    if not slug:
        return slug
    m = re.search(r'tournament/([^/?#]+)/event/([^/?#]+)', str(slug), re.I)
    if m:
        return f"tournament/{m.group(1)}/event/{m.group(2)}"
    return str(slug).strip()


def load_config(path):
    if not path:
        return {}
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        log(f"config {path} not found; using command-line flags only")
        return {}
    except (OSError, ValueError) as e:
        log(f"could not read config {path}: {e}")
        return {}


def read_json(path):
    """Parse a JSON file, or return None if it isn't ready/valid yet.

    A None here is normal: the mod may be mid-write when we poll, so we simply
    retry on the next pass rather than treating a partial file as an error.
    """
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


class Sender:
    def __init__(self, broker, slug, station, out_dir, state_path, dry_run, key=None):
        self.broker = broker.rstrip("/")
        self.slug = normalize_slug(slug)
        self.station = station
        self.key = key or None  # required: same shared secret as the broker's OPERATOR_KEY
        self.out_dir = Path(out_dir)
        self.sets_dir = self.out_dir / "sets"
        self.current_path = self.out_dir / "current.json"
        self.live_path = self.out_dir / "live.json"
        self.state_path = Path(state_path)
        self.dry_run = dry_run
        self.state = self._load_state()

    # -- persistence --------------------------------------------------------
    def _load_state(self):
        try:
            s = json.loads(self.state_path.read_text(encoding="utf-8"))
            if s.get("version") == STATE_VERSION:
                s.setdefault("sent_sets", [])
                return s
        except (OSError, ValueError):
            pass
        return {"version": STATE_VERSION, "sent_sets": [], "current_hash": None}

    def _save_state(self):
        if self.dry_run:
            return
        tmp = self.state_path.with_suffix(self.state_path.suffix + ".tmp")
        try:
            tmp.write_text(json.dumps(self.state, indent=2), encoding="utf-8")
            tmp.replace(self.state_path)
        except OSError as e:
            log(f"could not write state {self.state_path}: {e}")

    # -- work helpers -------------------------------------------------------
    def _payload(self, extra):
        p = {"slug": self.slug, "station": self.station}
        if self.key:
            p["key"] = self.key
        p.update(extra)
        return p

    # -- network ------------------------------------------------------------
    def _post(self, endpoint, payload):
        url = f"{self.broker}{endpoint}"
        if self.dry_run:
            log(f"DRY-RUN POST {url}\n{json.dumps(payload, indent=2)[:800]}")
            return True
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            url, data=data, method="POST",
            # An explicit User-Agent is required: Cloudflare's bot rules 403 the
            # default "Python-urllib/x.y" signature (error 1010) before the
            # request ever reaches the Worker.
            headers={"Content-Type": "application/json",
                     "User-Agent": "rivals-station-sender/1.0"},
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                resp.read()
                return 200 <= resp.status < 300
        except urllib.error.HTTPError as e:
            log(f"POST {endpoint} -> HTTP {e.code} {e.reason}")
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            log(f"POST {endpoint} failed: {e} (will retry)")
        return False

    # -- work ---------------------------------------------------------------
    def process_sets(self):
        if not self.sets_dir.is_dir():
            return
        sent = set(self.state["sent_sets"])
        for path in sorted(self.sets_dir.glob("*.json")):
            if path.name in sent:
                continue
            body = read_json(path)
            if body is None:
                continue  # partial write; try again next pass
            ok = self._post("/matchlogger/ingest", self._payload({"set": body}))
            if ok:
                log(f"ingested {path.name}")
                self.state["sent_sets"].append(path.name)
                self._save_state()

    def process_current(self):
        if not self.current_path.is_file():
            return
        raw = self.current_path.read_bytes()
        digest = hashlib.sha1(raw).hexdigest()
        if digest == self.state.get("current_hash"):
            return  # unchanged since last heartbeat
        body = read_json(self.current_path)
        if body is None:
            return
        ok = self._post("/matchlogger/current", self._payload({"current": body}))
        if ok:
            log(f"heartbeat: {body.get('state', '?')}")
            self.state["current_hash"] = digest
            self._save_state()

    def process_live(self):
        # Running per-game snapshot → live (non-finalizing) start.gg score.
        if not self.live_path.is_file():
            return
        raw = self.live_path.read_bytes()
        digest = hashlib.sha1(raw).hexdigest()
        if digest == self.state.get("live_hash"):
            return
        body = read_json(self.live_path)
        if body is None:
            return
        # The mod writes {"complete": true} when the set ends — nothing to push.
        if not body.get("complete"):
            ok = self._post("/matchlogger/live", self._payload({"set": body}))
            if not ok:
                return  # retry next pass; leave the hash so a later change re-sends
            log(f"live: {body.get('matchCount', '?')} game(s)")
        self.state["live_hash"] = digest
        self._save_state()

    def tick(self):
        # Heartbeat first: it's time-sensitive (drives start.gg pre-binding).
        self.process_current()
        self.process_live()
        self.process_sets()


def default_save_paths():
    """Standard %LOCALAPPDATA% locations for the stats save and replays folder."""
    base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / "Rivals2" / "Saved"
    return (str(base / "SaveGames" / "Rivals2_StatsSaveSlot.sav"), str(base / "Replays"))


def build_sender(cfg):
    # In stats-diff mode the sender produces its own files, so --dir defaults to
    # a working folder it owns rather than a mod-written one.
    if cfg.get("source") == "stats" and not cfg.get("dir"):
        cfg["dir"] = str(Path.cwd() / "matchlogger-out")
    missing = [k for k in ("broker", "slug", "station", "dir") if not cfg.get(k)]
    if missing:
        sys.exit(f"[station-sender] missing required config: {', '.join(missing)}")
    state_path = cfg.get("state") or str(Path(cfg["dir"]) / ".station-sender-state.json")
    return Sender(
        broker=cfg["broker"], slug=cfg["slug"], station=cfg["station"],
        out_dir=cfg["dir"], state_path=state_path, dry_run=cfg.get("dry_run", False),
        key=cfg.get("key"),
    )


def main(argv=None):
    p = argparse.ArgumentParser(description="MatchLogger station sender (headless).")
    p.add_argument("--broker")
    p.add_argument("--slug", help="start.gg event slug, e.g. tournament/foo/event/bar")
    p.add_argument("--station", type=int)
    p.add_argument("--dir", help="MatchLogger output folder (contains sets/ and current.json)")
    p.add_argument("--poll", type=float, default=2.0)
    p.add_argument("--state", help="state file path (default: <dir>/.station-sender-state.json)")
    p.add_argument("--key", help="shared key (same value as the broker's OPERATOR_KEY secret) — required")
    p.add_argument("--config", help="JSON config file; flags override it")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--once", action="store_true", help="run one pass and exit")
    p.add_argument("--source", choices=("mod", "stats"), default="mod",
                   help="'mod' (default): forward files written by the UE4SS mod. "
                        "'stats': no mod - watch the stats save + replays and produce them here.")
    p.add_argument("--save", help="[stats] Rivals2_StatsSaveSlot.sav path (default: %%LOCALAPPDATA%%)")
    p.add_argument("--replays", help="[stats] Replays folder path (default: %%LOCALAPPDATA%%)")
    p.add_argument("--idle", type=float, default=180.0,
                   help="[stats] finalize an open set after this many idle seconds")
    p.add_argument("--players", help="[stats] JSON map of save-tag -> start.gg tag "
                                     "(default: players.json next to this script, if present)")
    p.add_argument("--no-display", action="store_true",
                   help="[stats] disable the live scoreboard (plain log lines instead)")
    args = p.parse_args(argv)

    cfg = load_config(args.config)
    for key in ("broker", "slug", "station", "dir", "state", "key", "source", "save", "replays"):
        val = getattr(args, key)
        if val is not None:
            cfg[key] = val
    cfg["poll"] = args.poll if args.poll is not None else cfg.get("poll", 2.0)
    cfg["dry_run"] = args.dry_run
    cfg.setdefault("source", "mod")
    cfg["idle"] = args.idle

    producer = None

    if cfg["source"] == "stats":
        # No mod: the sender watches the save + replays and produces the files
        # itself into its own --dir. Forwarding to the broker is OPTIONAL — with
        # no broker/slug it runs local-only (scoreboard + files), so it works
        # even without a start.gg bracket.
        global _log_hook
        import rivals_stats
        def_save, def_replays = default_save_paths()

        out_dir = cfg.get("dir") or str(Path.cwd() / "matchlogger-out")
        cfg["dir"] = out_dir
        station = cfg.get("station") or 1
        cfg["station"] = station
        slug = cfg.get("slug")
        forwarder = build_sender(cfg) if (cfg.get("broker") and slug) else None

        # Optional save-tag -> start.gg-tag alias map for the scoreboard.
        aliases = {}
        players_path = args.players or str(Path(__file__).resolve().parent / "players.json")
        try:
            aliases = json.loads(Path(players_path).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass

        on_change = None
        if not args.no_display:
            from dashboard import Dashboard
            mode = "DRY-RUN" if cfg["dry_run"] else ("live" if forwarder else "local-only")
            dash = Dashboard(station, slug or "(no bracket)", mode, aliases)
            _log_hook = dash.log          # route all logs into the scoreboard
            on_change = dash.update       # re-render whenever a set changes
            dash.render()                 # initial empty board

        producer = rivals_stats.StatsProducer(
            save_path=cfg.get("save") or def_save,
            replays_dir=cfg.get("replays") or def_replays,
            out_dir=out_dir, idle_s=cfg["idle"], log=log, on_change=on_change,
        )
        log("source stats | station %s | %s | out %s%s" % (
            station, slug or "(no bracket)", out_dir,
            "" if forwarder else " | local-only (no broker)"))
    else:
        forwarder = build_sender(cfg)
        log(f"station {forwarder.station} | event {forwarder.slug} | source mod | {forwarder.out_dir}"
            + (" | DRY-RUN" if forwarder.dry_run else ""))

    if args.once:
        if producer:
            producer.poll()
        if forwarder:
            forwarder.tick()
        return

    try:
        while True:
            if producer:
                producer.poll()
            if forwarder:
                forwarder.tick()
            time.sleep(cfg["poll"])
    except KeyboardInterrupt:
        if producer:
            producer.shutdown()
            if forwarder:
                forwarder.tick()  # forward the interrupted-set file before exiting
        log("stopped")


if __name__ == "__main__":
    main()
