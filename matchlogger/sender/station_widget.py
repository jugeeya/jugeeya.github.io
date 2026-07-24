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
from tkinter import filedialog, ttk

import station_sender as ss
import rivals_stats

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
    ("broker", "Broker URL"),
    ("slug", "start.gg event (optional)"),
    ("dir", "Output / MatchLogger folder"),
    ("key", "Shared key (broker's OPERATOR_KEY — required to send)"),
)


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
        self.config_path = config_path
        self.aliases = load_aliases(config_path)
        self.sender = None           # broker forwarder (optional)
        self.producer = None         # stats producer (stats mode)
        self.sender_lock = threading.Lock()
        self.running = True
        self.tray_icon = None
        self._log_rendered = -1
        self._snapshot = {"history": [], "live": None}
        self._snap_lock = threading.Lock()
        self._snap_ver = 0
        self._snap_rendered = -1

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
    def _on_change(self, snap):
        with self._snap_lock:
            self._snapshot = snap
            self._snap_ver += 1

    def _build_producer(self):
        if self.cfg.get("source") != "stats":
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
        """(Re)build the broker forwarder. Optional in stats mode."""
        src = self.cfg.get("source", "stats")
        try:
            if src == "stats" and not (self.cfg.get("broker") and self.cfg.get("slug")):
                with self.sender_lock:
                    self.sender = None            # local-only: no bracket to send to
                return True
            with self.sender_lock:
                self.sender = ss.build_sender(dict(self.cfg))
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

        self.dot = tk.Canvas(frm, width=10, height=10, highlightthickness=0)
        self.dot.grid(row=1, column=0, sticky="w", padx=8)
        self._dot_id = self.dot.create_oval(1, 1, 9, 9, fill="#7fd39a", outline="")

        self.status = ttk.Label(frm, text="starting…", wraplength=320, foreground="#555")
        self.status.grid(row=2, column=0, sticky="w", padx=8, pady=(0, 4))

        self.event_label = ttk.Label(frm, text=self.cfg.get("slug") or "(no event — local scoreboard)",
                                     wraplength=320, foreground="#888", font=("", 8))
        self.event_label.grid(row=3, column=0, sticky="w", padx=8)

        # Sets table — the live scoreboard.
        sets_frame = ttk.Frame(frm, padding=(8, 6, 8, 2))
        sets_frame.grid(row=4, column=0, sticky="we")
        cols = ("tag", "gg", "char", "score")
        self.tree = ttk.Treeview(sets_frame, columns=cols, show="tree headings", height=8)
        self.tree.heading("#0", text="Time")
        self.tree.column("#0", width=64, anchor="w", stretch=False)
        for c, label, w in (("tag", "Tag", 82), ("gg", "start.gg", 92),
                            ("char", "Character", 96), ("score", "Score", 48)):
            self.tree.heading(c, text=label)
            self.tree.column(c, width=w, anchor="w", stretch=False)
        self.tree.column("score", anchor="center")
        self.tree.tag_configure("win", font=("TkDefaultFont", 9, "bold"))
        self.tree.tag_configure("live", foreground="#3b7fd0")
        self.tree.grid(row=0, column=0, sticky="we")
        self._empty_note = ttk.Label(sets_frame, text="waiting for a game…",
                                     foreground="#999", font=("", 8))

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

    def _render_sets(self):
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
            for i, r in enumerate(grp):
                tags = []
                if r["won"]:
                    tags.append("win")
                if live:
                    tags.append("live")
                self.tree.insert("", "end",
                    text=(head + ("  ●" if live else "") if i == 0 else ""),
                    values=(r["tag"], r["gg"] or "—", r["char"], r["wins"]), tags=tuple(tags))

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
    p.add_argument("--station", type=int)
    args = p.parse_args(argv)

    config_path = args.config
    if not Path(config_path).is_absolute():
        config_path = str(Path(__file__).resolve().parent / config_path)

    cfg = ss.load_config(config_path if Path(config_path).exists() else None)
    for f in ("broker", "slug", "dir", "key", "source", "station"):
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
