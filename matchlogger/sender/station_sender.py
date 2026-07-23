#!/usr/bin/env python3
"""MatchLogger station sender — headless.

Watches a MatchLogger output folder on a game PC and forwards what it finds to
the broker, stamping this machine's station number on the way out:

  * new  <dir>/sets/*.json   -> POST <broker>/matchlogger/ingest
  * changed <dir>/current.json -> POST <broker>/matchlogger/current   (heartbeat)

This is the only piece that runs on stations 2..N, so it has no UI and no
secrets: the broker holds those. Its station number is its only real config.
Standard library only (no pip installs) so it freezes cleanly into an .exe
later.

Usage:
  python station_sender.py --broker https://r2tag-broker.jdsambasivam.workers.dev \
      --slug tournament/foo/event/bar --station 3 \
      --dir "C:/.../Rivals2/Binaries/Win64/MatchLogger"

Flags of note:
  --dry-run   print the requests instead of sending them
  --once      one pass then exit (for testing / cron-style use)
  --poll N    seconds between passes (default 2)
  --config F  JSON file with any of {broker, slug, station, dir, poll};
              explicit command-line flags win over it.
"""

import argparse
import hashlib
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

STATE_VERSION = 1


def log(msg):
    # Under pythonw (no console) stdout is missing; logging must never crash.
    try:
        print(f"[station-sender] {msg}", flush=True)
    except Exception:
        pass


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
        self.slug = slug
        self.station = station
        self.key = key or None  # only needed if the broker has STATION_KEY set
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
            headers={"Content-Type": "application/json"},
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


def build_sender(cfg):
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
    p.add_argument("--key", help="station key (only if the broker has STATION_KEY set)")
    p.add_argument("--config", help="JSON config file; flags override it")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--once", action="store_true", help="run one pass and exit")
    args = p.parse_args(argv)

    cfg = load_config(args.config)
    for key in ("broker", "slug", "station", "dir", "state", "key"):
        val = getattr(args, key)
        if val is not None:
            cfg[key] = val
    cfg["poll"] = args.poll if args.poll is not None else cfg.get("poll", 2.0)
    cfg["dry_run"] = args.dry_run

    sender = build_sender(cfg)
    log(f"station {sender.station} · event {sender.slug} · watching {sender.out_dir}"
        + (" · DRY-RUN" if sender.dry_run else ""))

    if args.once:
        sender.tick()
        return

    try:
        while True:
            sender.tick()
            time.sleep(cfg["poll"])
    except KeyboardInterrupt:
        log("stopped")


if __name__ == "__main__":
    main()
