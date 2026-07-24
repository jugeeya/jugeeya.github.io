#!/usr/bin/env python3
"""MatchLogger station widget — a small corner window that runs the station
sender, lets you edit its settings, and shows a live scoreboard of the sets it
detects.

It wraps `station_sender.py` (the headless core). Closing the window sends it to
the system tray (if `pystray` + `pillow` are installed) rather than quitting.

  Windows: double-click rivals-station-reporter.pyw   (no terminal window)
  Anywhere: python station_widget.py

Default mode is **stats** (no UE4SS mod): it watches Rivals2_StatsSaveSlot.sav +
the Replays folder, reconstructs each set, shows it in the Sets table, and — if a
broker + start.gg event are configured — forwards it. With no event set it still
runs, showing the scoreboard locally (works without a bracket).

The Sets table shows, per player: tag, inferred start.gg tag (from players.json,
if present), character, and score; the set winner is bold. Set `"source": "mod"`
in the config to instead forward files written by the in-game mod.
"""

import argparse
import collections
import json
import threading
import time
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

import station_sender as ss
import rivals_stats
import matching
import hub

# Optional tray support.
try:
    import pystray
    from PIL import Image, ImageDraw
    HAVE_TRAY = True
except Exception:
    HAVE_TRAY = False

POLL_SEC = 2.0
LOG_LINES = 200
DEFAULT_BROKER = "https://r2tag-broker.jdsambasivam.workers.dev"

# Capture the sender's log lines for the status row and the Log panel
# (non-invasive: the core stays a plain module).
_last = {"msg": "starting…", "t": time.time(), "error": False}
_log = collections.deque(maxlen=LOG_LINES)
_log_count = 0
_orig_log = ss.log
def _cap_log(msg):
    global _log_count
    _last.update(msg=msg, t=time.time(), error=("fail" in msg.lower() or "error" in msg.lower()))
    _log.append(f"{time.strftime('%H:%M:%S')}  {msg}")
    _log_count += 1
    _orig_log(msg)
ss.log = _cap_log


def poll_extras():
    """Return {label: value} rows to show under the sender status."""
    return {"OBS": "not wired up"}


SETTINGS_FIELDS = (
    ("broker", "Hub / broker URL"),
    ("slug", "start.gg event (optional)"),
    ("dir", "Output / MatchLogger folder"),
    ("key", "Shared key (must match the operator's — required to send)"),
    ("startgg_token", "start.gg API token (operator only)"),
)

# station : watch this PC's games, send them to the hub/broker.
# operator: run the LAN hub — stations POST here, and this is the only machine
#           that talks to start.gg. Adds the console view to the window.
# both    : this PC is a station AND the operator.
MODES = ("station", "operator", "both")


def load_aliases(config_path):
    """save-tag -> start.gg-tag map from players.json next to the config."""
    try:
        return json.loads((Path(config_path).resolve().parent / "players.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


class Widget:
    def __init__(self, cfg, config_path):
        self.cfg = cfg
        self.cfg.setdefault("source", "stats")
        self.cfg.setdefault("mode", "station")
        self.config_path = config_path
        self.aliases = load_aliases(config_path)
        self.sender = None           # broker/hub forwarder (optional)
        self.producer = None         # stats producer (station side)
        self.hub = None              # LAN hub (operator side)
        self.hub_server = None
        self.sender_lock = threading.Lock()
        self.running = True
        self.tray_icon = None
        self._log_rendered = -1
        self._snapshot = {"history": [], "live": None}
        self._hub_snapshot = {"sets": [], "stations": {}}
        self._snap_lock = threading.Lock()
        self._snap_ver = 0
        self._snap_rendered = -1
        self._row_recs = {}          # treeview iid -> hub record (operator mode)

        self._build_hub()
        self._build_producer()
        self._build_sender()

        self.root = tk.Tk()
        self.root.title("Rivals Station")
        self.root.resizable(False, False)
        self._build_ui()
        self.root.protocol("WM_DELETE_WINDOW", self.on_close)

        # In mod mode a missing config is fatal; open Settings so it's fixable.
        if self.cfg.get("source") != "stats" and any(not self.cfg.get(k) for k in ("broker", "slug", "station", "dir")):
            self._set_status("fill in Settings to start", True)
            self.settings_frame.grid()
            self.settings_btn.config(text="Settings ▾")

        self._place_bottom_right()
        threading.Thread(target=self._loop, daemon=True).start()
        if HAVE_TRAY:
            self._start_tray()
        self._refresh_status()

    # -- runtime -----------------------------------------------------------
    @property
    def is_operator(self):
        return self.cfg.get("mode") in ("operator", "both")

    @property
    def is_station(self):
        return self.cfg.get("mode") in ("station", "both")

    def _on_change(self, snap):
        with self._snap_lock:
            self._snapshot = snap
            self._snap_ver += 1

    def _on_hub_change(self, snap):
        with self._snap_lock:
            self._hub_snapshot = snap
            self._snap_ver += 1

    def _build_hub(self):
        """Operator mode: run the LAN hub. Stations POST here and this process
        is the only one that talks to start.gg."""
        self._stop_hub()
        if not self.is_operator:
            return
        try:
            here = Path(self.config_path).resolve().parent
            self.hub = hub.Hub(
                key=(self.cfg.get("key") or "").strip() or None,
                token=self.cfg.get("startgg_token"),
                tag_map=matching.build_tag_map(self.aliases),
                state_path=str(here / "hub-state.json"),
                log=ss.log, on_change=self._on_hub_change)
            self.hub_server = hub.HubServer(
                self.hub, port=int(self.cfg.get("hub_port", hub.DEFAULT_PORT)))
            self.hub_server.start()
            self._on_hub_change(self.hub.snapshot())
        except Exception as e:
            self.hub, self.hub_server = None, None
            _last.update(msg=f"hub failed to start: {e}", t=time.time(), error=True)

    def _stop_hub(self):
        if self.hub_server:
            try:
                self.hub_server.stop()
            except Exception:
                pass
        self.hub, self.hub_server = None, None

    def _build_producer(self):
        # The operator machine is often not a station; only watch the save when
        # this PC actually plays games.
        if not self.is_station or self.cfg.get("source") != "stats":
            self.producer = None
            return
        try:
            out_dir = self.cfg.get("dir") or str(Path(self.config_path).resolve().parent / "matchlogger-out")
            self.cfg["dir"] = out_dir
            self.cfg.setdefault("station", 1)
            def_save, def_replays = ss.default_save_paths()
            self.producer = rivals_stats.StatsProducer(
                save_path=self.cfg.get("save") or def_save,
                replays_dir=self.cfg.get("replays") or def_replays,
                out_dir=out_dir, idle_s=float(self.cfg.get("idle", 180)),
                log=ss.log, on_change=self._on_change)
        except Exception as e:  # never let setup crash the widget
            self.producer = None
            _last.update(msg=f"stats setup error: {e}", t=time.time(), error=True)

    def _build_sender(self):
        """(Re)build the forwarder that ships this PC's games. Points at the
        local hub when we're also the operator, otherwise at the configured
        hub/broker URL. Not used at all on an operator-only machine."""
        src = self.cfg.get("source", "stats")
        try:
            if not self.is_station:
                with self.sender_lock:
                    self.sender = None
                return True
            cfg = dict(self.cfg)
            if self.is_operator and self.hub_server:
                # "both": don't round-trip the LAN, talk to our own hub.
                cfg["broker"] = "http://127.0.0.1:%d" % self.hub_server.port
            if src == "stats" and not (cfg.get("broker") and cfg.get("slug")):
                with self.sender_lock:
                    self.sender = None            # local-only: nowhere to send
                return True
            with self.sender_lock:
                self.sender = ss.build_sender(cfg)
            return True
        except SystemExit as e:
            with self.sender_lock:
                self.sender = None
            _last.update(msg=str(e), t=time.time(), error=True)
            return False

    def _loop(self):
        while self.running:
            if self.producer:
                try:
                    self.producer.poll()
                except Exception as e:
                    _last.update(msg=f"poll error: {e}", t=time.time(), error=True)
            with self.sender_lock:
                s = self.sender
            if s:
                try:
                    s.tick()
                except Exception as e:
                    _last.update(msg=f"tick error: {e}", t=time.time(), error=True)
            time.sleep(self.cfg.get("poll", POLL_SEC))

    def apply_station(self):
        try:
            n = int(self.station_var.get())
        except (TypeError, ValueError):
            self._set_status("station must be a number", True)
            return
        self.cfg["station"] = n
        if self._build_sender():
            self._save_config()
            self._set_status(f"now station {n}", False)

    def save_settings(self):
        for key, var in self.setting_vars.items():
            val = var.get().strip()
            if val:
                self.cfg[key] = val
            else:
                self.cfg.pop(key, None)
        if self.cfg.get("slug"):  # accept a pasted start.gg URL, store the clean slug
            self.cfg["slug"] = ss.normalize_slug(self.cfg["slug"])
            self.setting_vars["slug"].set(self.cfg["slug"])
        try:
            self.cfg["station"] = int(self.station_var.get())
        except (TypeError, ValueError):
            self._set_status("station must be a number", True)
            return
        # key / token / port can all change here, so the hub restarts with them.
        self._build_hub()
        if not self._build_sender():
            return
        self._save_config()
        self.event_label.config(text=self.cfg.get("slug") or "(no event — local scoreboard)")
        self._set_status("settings saved", False)

    def _browse_dir(self):
        current = self.setting_vars["dir"].get().strip()
        chosen = filedialog.askdirectory(initialdir=current or str(Path.home()),
                                         title="Output folder")
        if chosen:
            self.setting_vars["dir"].set(chosen)

    def _save_config(self):
        try:
            with open(self.config_path, "w", encoding="utf-8") as f:
                json.dump(self.cfg, f, indent=2)
        except OSError as e:
            self._set_status(f"couldn't save config: {e}", True)

    # -- ui ----------------------------------------------------------------
    def _build_ui(self):
        pad = dict(padx=8, pady=3)
        frm = ttk.Frame(self.root, padding=8)
        frm.grid(sticky="nsew")

        row = ttk.Frame(frm)
        row.grid(row=0, column=0, sticky="w")
        ttk.Label(row, text="Station").grid(row=0, column=0, **pad)
        self.station_var = tk.StringVar(value=str(self.cfg.get("station", 1)))
        ttk.Spinbox(row, from_=0, to=99, width=4, textvariable=self.station_var).grid(row=0, column=1, **pad)
        ttk.Button(row, text="Apply", command=self.apply_station).grid(row=0, column=2, **pad)
        ttk.Label(row, text="Mode").grid(row=0, column=3, padx=(12, 2))
        self.mode_var = tk.StringVar(value=self.cfg.get("mode", "station"))
        mode_box = ttk.Combobox(row, width=9, state="readonly", values=MODES,
                                textvariable=self.mode_var)
        mode_box.grid(row=0, column=4, **pad)
        mode_box.bind("<<ComboboxSelected>>", lambda _e: self.apply_mode())

        # Operator: the address stations point at.
        self.hub_label = ttk.Label(frm, text="", foreground="#3b7fd0", font=("", 8))
        self.hub_label.grid(row=9, column=0, sticky="w", padx=8, pady=(2, 0))

        self.dot = tk.Canvas(frm, width=10, height=10, highlightthickness=0)
        self.dot.grid(row=1, column=0, sticky="w", padx=8)
        self._dot_id = self.dot.create_oval(1, 1, 9, 9, fill="#7fd39a", outline="")

        self.status = ttk.Label(frm, text="starting…", wraplength=320, foreground="#555")
        self.status.grid(row=2, column=0, sticky="w", padx=8, pady=(0, 4))

        self.event_label = ttk.Label(frm, text=self.cfg.get("slug") or "(no event — local scoreboard)",
                                     wraplength=320, foreground="#888", font=("", 8))
        self.event_label.grid(row=3, column=0, sticky="w", padx=8)

        # Sets table — the live scoreboard (station) / console (operator).
        sets_frame = ttk.Frame(frm, padding=(8, 6, 8, 2))
        sets_frame.grid(row=4, column=0, sticky="we")
        cols = ("stn", "tag", "gg", "char", "score", "round", "status")
        self.tree = ttk.Treeview(sets_frame, columns=cols, show="tree headings", height=8)
        self.tree.heading("#0", text="Time")
        self.tree.column("#0", width=64, anchor="w", stretch=False)
        for c, label, w in (("stn", "Stn", 34), ("tag", "Tag", 82), ("gg", "start.gg", 92),
                            ("char", "Character", 96), ("score", "Score", 48),
                            ("round", "Round", 104), ("status", "Status", 70)):
            self.tree.heading(c, text=label)
            self.tree.column(c, width=w, anchor="w", stretch=False)
        self.tree.column("score", anchor="center")
        self.tree.tag_configure("win", font=("TkDefaultFont", 9, "bold"))
        self.tree.tag_configure("live", foreground="#3b7fd0")
        self.tree.tag_configure("reported", foreground="#2e7d4f")
        # online/ranked: shown, but greyed out — they can't touch the bracket.
        self.tree.tag_configure("notreportable", foreground="#999")
        self.tree.grid(row=0, column=0, sticky="we")
        self._apply_columns()
        self._empty_note = ttk.Label(sets_frame, text="waiting for a game…",
                                     foreground="#999", font=("", 8))

        # Operator actions, on the selected set.
        self.actions = ttk.Frame(sets_frame)
        self.actions.grid(row=2, column=0, sticky="w", pady=(4, 0))
        self.report_btn = ttk.Button(self.actions, text="Report winner…", command=self.on_report)
        self.report_btn.grid(row=0, column=0, padx=(0, 4))
        ttk.Button(self.actions, text="Switch winner", command=self.on_swap).grid(row=0, column=1, padx=4)
        ttk.Button(self.actions, text="Delete", command=self.on_delete).grid(row=0, column=2, padx=4)

        self.extras = ttk.Label(frm, text="", foreground="#888", font=("", 8))
        self.extras.grid(row=5, column=0, sticky="w", padx=8, pady=(2, 0))

        toggles = ttk.Frame(frm)
        toggles.grid(row=6, column=0, sticky="w", pady=(6, 0))
        self.settings_btn = ttk.Button(toggles, text="Settings ▸",
            command=lambda: self._toggle(self.settings_frame, self.settings_btn, "Settings"))
        self.settings_btn.grid(row=0, column=0, padx=(8, 4))
        self.log_btn = ttk.Button(toggles, text="Log ▸",
            command=lambda: self._toggle(self.log_frame, self.log_btn, "Log"))
        self.log_btn.grid(row=0, column=1)

        self.settings_frame = ttk.Frame(frm, padding=(8, 6, 8, 2))
        self.settings_frame.grid(row=7, column=0, sticky="we")
        self.settings_frame.grid_remove()
        self.setting_vars = {}
        for i, (key, label) in enumerate(SETTINGS_FIELDS):
            ttk.Label(self.settings_frame, text=label, font=("", 8)).grid(
                row=i * 2, column=0, columnspan=2, sticky="w")
            var = tk.StringVar(value=str(self.cfg.get(key, "") or ""))
            self.setting_vars[key] = var
            entry = ttk.Entry(self.settings_frame, width=40, textvariable=var)
            entry.grid(row=i * 2 + 1, column=0, sticky="we", pady=(0, 3))
            if key == "dir":
                ttk.Button(self.settings_frame, text="…", width=2,
                           command=self._browse_dir).grid(row=i * 2 + 1, column=1, padx=(3, 0))
        ttk.Button(self.settings_frame, text="Save", command=self.save_settings).grid(
            row=len(SETTINGS_FIELDS) * 2, column=0, sticky="w", pady=(3, 0))

        self.log_frame = ttk.Frame(frm, padding=(8, 6, 8, 2))
        self.log_frame.grid(row=8, column=0, sticky="we")
        self.log_frame.grid_remove()
        self.log_text = tk.Text(self.log_frame, height=8, width=46, state="disabled",
                                font=("Courier", 9), wrap="none", relief="flat", background="#f4f2f7")
        self.log_text.grid(row=0, column=0, sticky="we")

    def _tag_map(self):
        """players.json, keyed for matching (cached per render pass)."""
        if getattr(self, "_tag_map_cache", None) is None:
            self._tag_map_cache = matching.build_tag_map(self.aliases)
        return self._tag_map_cache

    def _apply_columns(self):
        """Station mode hides the operator-only columns."""
        if self.is_operator:
            self.tree.configure(displaycolumns=("stn", "tag", "gg", "char", "score", "round", "status"))
        else:
            self.tree.configure(displaycolumns=("tag", "gg", "char", "score"))

    def apply_mode(self):
        mode = self.mode_var.get()
        if mode not in MODES:
            return
        self.cfg["mode"] = mode
        self._build_hub()
        self._build_producer()
        self._build_sender()
        self._apply_columns()
        self._save_config()
        self._set_status(f"mode: {mode}", False)
        with self._snap_lock:
            self._snap_ver += 1

    # -- operator actions --------------------------------------------------
    def _selected_rec(self):
        sel = self.tree.selection()
        if not sel:
            self._set_status("select a set first", True)
            return None
        rec = self._row_recs.get(sel[0])
        if not rec:
            self._set_status("select a set row", True)
        return rec

    def on_report(self):
        """Finalize on start.gg — the one action that advances the bracket, so
        it always asks which entrant won."""
        rec = self._selected_rec()
        if not rec or not self.hub:
            return
        if not rec.get("reportable", True):
            self._set_status(
                f"{rivals_stats.mode_label(rec.get('mode')) or 'non-local'} game — "
                f"logged for reference, but it can't be reported to the bracket", True)
            return
        entrants = rec.get("entrants") or []
        if len(entrants) < 2:
            self._set_status("no start.gg entrants to pick from", True)
            return
        win = tk.Toplevel(self.root)
        win.title("Report winner")
        win.resizable(False, False)
        ttk.Label(win, text="Who won this set?", padding=8).grid(row=0, column=0, columnspan=2)

        def pick(eid):
            win.destroy()
            res = self.hub.do_report(self.cfg.get("slug") or "", rec["station"], rec["id"], eid)
            if isinstance(res, tuple):
                self._set_status(f"report failed: {res[0].get('error')}", True)
            else:
                self._set_status(f"reported {rec['id']} to start.gg", False)

        for i, e in enumerate(entrants[:2]):
            suggested = str(e.get("id")) == str(rec.get("candidateWinnerEntrantId"))
            label = (e.get("name") or "entrant") + ("  (suggested)" if suggested else "")
            ttk.Button(win, text=label, width=26,
                       command=lambda eid=e.get("id"): pick(eid)).grid(
                row=1 + i, column=0, columnspan=2, padx=8, pady=3)
        ttk.Button(win, text="Cancel", command=win.destroy).grid(
            row=3, column=0, columnspan=2, pady=(4, 8))
        win.transient(self.root)
        win.grab_set()

    def on_swap(self):
        """The station guessed the two players backwards — flip the mapping and
        re-push the corrected live score."""
        rec = self._selected_rec()
        if not rec or not self.hub:
            return
        if not rec.get("reportable", True):
            self._set_status("that game isn't tied to a bracket set — nothing to swap", True)
            return
        res = self.hub.do_swap(self.cfg.get("slug") or "", rec["station"], rec["id"])
        if isinstance(res, tuple):
            self._set_status(f"swap failed: {res[0].get('error')}", True)
        else:
            self._set_status("swapped tags" + (" and re-pushed" if res.get("repushed") else ""), False)

    def on_delete(self):
        rec = self._selected_rec()
        if not rec or not self.hub:
            return
        who = " vs ".join(p.get("name") or "?" for p in ((rec.get("set") or {}).get("players") or []))
        if not messagebox.askyesno("Delete set",
                                   f"Remove {who or rec['id']} (station {rec['station']}) "
                                   f"from the console?\n\nstart.gg is not touched."):
            return
        res = self.hub.do_delete(self.cfg.get("slug") or "", rec["station"], rec["id"])
        if isinstance(res, tuple):
            self._set_status(f"delete failed: {res[0].get('error')}", True)
        else:
            self._set_status("set deleted", False)

    def _render_sets(self):
        if self.is_operator:
            return self._render_operator_sets()
        self.actions.grid_remove()
        self._row_recs.clear()
        rows = rivals_stats.format_set_rows(self._snapshot, self.aliases)
        self.tree.delete(*self.tree.get_children())
        if not rows:
            self._empty_note.grid(row=1, column=0, sticky="w")
            return
        self._empty_note.grid_remove()
        # group consecutive rows into sets, then show newest set first
        groups, cur = [], []
        for r in rows:
            if r["first"] and cur:
                groups.append(cur); cur = []
            cur.append(r)
        if cur:
            groups.append(cur)
        for grp in reversed(groups):
            head = time.strftime("%H:%M", time.localtime(grp[0]["startEpoch"]))
            live = not grp[0]["complete"]
            reportable = grp[0].get("reportable", True)
            label = rivals_stats.mode_label(grp[0].get("mode"))
            for i, r in enumerate(grp):
                tags = []
                if not reportable:
                    tags.append("notreportable")
                else:
                    if r["won"]:
                        tags.append("win")
                    if live:
                        tags.append("live")
                # Mark online/ranked so it's obvious why it won't be reported.
                marker = "  ●" if (live and reportable) else ("  " + label if label else "")
                self.tree.insert("", "end",
                    text=(head + marker if i == 0 else ""),
                    values=("", r["tag"], r["gg"] or "—", r["char"], r["wins"], "", ""),
                    tags=tuple(tags))

    def _render_operator_sets(self):
        """The console view: every station's sets, newest first, one row per
        player so tag/start.gg/character/score line up like the web console."""
        self.actions.grid()
        self.tree.delete(*self.tree.get_children())
        self._row_recs.clear()
        sets = (self._hub_snapshot or {}).get("sets") or []
        if not sets:
            self._empty_note.grid(row=1, column=0, sticky="w")
            return
        self._empty_note.grid_remove()
        for rec in sets:
            st = rec.get("set") or {}
            players = sorted(st.get("players") or [],
                             key=lambda p: (p.get("slot") is None, p.get("slot")))
            status = rec.get("status") or "recorded"
            reportable = rec.get("reportable", True)
            head = time.strftime("%H:%M", time.localtime(st.get("endEpoch")
                                                         or rec.get("ingestedAt") or 0))
            entrants = {str(e.get("id")): e.get("name") for e in (rec.get("entrants") or [])}
            top = max([p.get("wins") or 0 for p in players] or [0])
            # Which start.gg entrant each player maps to (once per set, not per row).
            smap = matching.map_slots_to_entrants(rec, None, self._tag_map()) or {}
            for i, p in enumerate(players):
                gg = entrants.get(str(smap.get(p.get("slot"))), "") or ""
                tags = []
                if not reportable:
                    tags.append("notreportable")
                else:
                    if (p.get("wins") or 0) == top and top > 0:
                        tags.append("win")
                    if status == "reported":
                        tags.append("reported")
                    elif status == "live":
                        tags.append("live")
                # An online/ranked game has no bracket round — say why instead.
                round_cell = (rec.get("fullRoundText") or "—") if reportable else "not a bracket set"
                iid = self.tree.insert(
                    "", "end",
                    text=(head + ("  ●" if status == "live" else "") if i == 0 else ""),
                    values=(rec.get("station") if i == 0 else "",
                            p.get("name") or "?", gg or "—",
                            rivals_stats.char_full(p.get("character") or ""),
                            p.get("wins") if p.get("wins") is not None else "",
                            round_cell if i == 0 else "",
                            status if i == 0 else ""),
                    tags=tuple(tags))
                self._row_recs[iid] = rec

    def _toggle(self, frame, btn, label, show=None):
        visible = bool(frame.grid_info())
        show = (not visible) if show is None else show
        if show == visible:
            return
        self.root.update_idletasks()
        bottom = self.root.winfo_y() + self.root.winfo_height()
        if show:
            frame.grid()
            btn.config(text=f"{label} ▾")
        else:
            frame.grid_remove()
            btn.config(text=f"{label} ▸")
        self.root.update_idletasks()
        y = max(0, bottom - self.root.winfo_reqheight())
        self.root.geometry(f"+{self.root.winfo_x()}+{y}")

    def _place_bottom_right(self):
        self.root.update_idletasks()
        w = self.root.winfo_reqwidth()
        h = self.root.winfo_reqheight()
        sw = self.root.winfo_screenwidth()
        sh = self.root.winfo_screenheight()
        self.root.geometry(f"+{sw - w - 24}+{sh - h - 60}")

    def _set_status(self, msg, error):
        _last.update(msg=msg, t=time.time(), error=error)

    def _refresh_status(self):
        age = int(time.time() - _last["t"])
        ago = "just now" if age < 2 else f"{age}s ago"
        self.status.config(text=f"{_last['msg']}  ·  {ago}")
        self.dot.itemconfig(self._dot_id, fill="#ffb4ab" if _last["error"] else "#7fd39a")
        rows = poll_extras()
        self.extras.config(text="   ".join(f"{k}: {v}" for k, v in rows.items()))
        if self.is_operator and self.hub_server:
            token_note = "" if (self.hub and self.hub.startgg.enabled) else "  ·  no start.gg token"
            self.hub_label.config(text=f"hub: {self.hub_server.url()}   (stations point here){token_note}")
        else:
            self.hub_label.config(text="")
        with self._snap_lock:
            ver = self._snap_ver
        if ver != self._snap_rendered:
            self._snap_rendered = ver
            self._render_sets()
        if self.log_frame.grid_info() and self._log_rendered != _log_count:
            self._log_rendered = _log_count
            self.log_text.config(state="normal")
            self.log_text.delete("1.0", "end")
            self.log_text.insert("1.0", "\n".join(_log))
            self.log_text.see("end")
            self.log_text.config(state="disabled")
        if self.running:
            self.root.after(1000, self._refresh_status)

    # -- tray --------------------------------------------------------------
    def _tray_image(self):
        img = Image.new("RGB", (64, 64), "#1d1b20")
        d = ImageDraw.Draw(img)
        d.ellipse((16, 16, 48, 48), fill="#8fd3e8")
        return img

    def _start_tray(self):
        menu = pystray.Menu(
            pystray.MenuItem("Show", self._tray_show, default=True),
            pystray.MenuItem("Quit", self._tray_quit))
        self.tray_icon = pystray.Icon("matchlogger", self._tray_image(), "Rivals station", menu)
        threading.Thread(target=self.tray_icon.run, daemon=True).start()

    def _tray_show(self, *_):
        self.root.after(0, self.root.deiconify)

    def _tray_quit(self, *_):
        self.root.after(0, self.quit)

    def on_close(self):
        if HAVE_TRAY:
            self.root.withdraw()
        else:
            self.root.iconify()

    def quit(self):
        self.running = False
        if self.producer:
            try:
                self.producer.shutdown()
            except Exception:
                pass
        self._stop_hub()
        if self.tray_icon:
            self.tray_icon.stop()
        self.root.destroy()

    def run(self):
        self.root.mainloop()


def main(argv=None):
    p = argparse.ArgumentParser(description="Rivals station widget.")
    p.add_argument("--config", default="config.json")
    for f in ("broker", "slug", "dir", "key", "source"):
        p.add_argument("--" + f)
    p.add_argument("--mode", choices=MODES, help="station | operator | both")
    p.add_argument("--station", type=int)
    args = p.parse_args(argv)

    config_path = args.config
    if not Path(config_path).is_absolute():
        config_path = str(Path(__file__).resolve().parent / config_path)

    cfg = ss.load_config(config_path if Path(config_path).exists() else None)
    for f in ("broker", "slug", "dir", "key", "source", "station", "mode"):
        v = getattr(args, f)
        if v is not None:
            cfg[f] = v
    cfg.setdefault("broker", DEFAULT_BROKER)
    cfg.setdefault("source", "stats")
    if cfg.get("slug"):  # tolerate a pasted start.gg URL in the config
        cfg["slug"] = ss.normalize_slug(cfg["slug"])
    Widget(cfg, config_path).run()


if __name__ == "__main__":
    main()
