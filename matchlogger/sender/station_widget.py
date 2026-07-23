#!/usr/bin/env python3
"""MatchLogger station widget — a small window (spawning in the corner of the
desktop) that runs the station sender, lets you edit all its settings, and
shows live status.

It wraps `station_sender.py` (the headless core does the real work): this file
is just a face on it. Closing the window sends it to the system tray (if
`pystray` + `pillow` are installed) rather than quitting.

  Windows: double-click rivals-station-reporter.pyw   (no terminal window)
  Anywhere: python station_widget.py

No config file editing needed: the Settings panel edits everything (broker,
event slug, station number, MatchLogger folder, and the shared key — required,
same value as the broker's OPERATOR_KEY secret) and writes it back to
`config.json` next to the script, so the next launch needs nothing. A config
file / command-line flags still work and pre-fill the fields, same as the
headless sender. The Log panel shows the sender's log lines — the same ones
the headless sender prints to a terminal.

Extending it: `poll_extras()` returns a dict of extra status rows shown under
the sender status — e.g. wire it to obs-websocket to show "OBS: recording".
Right now it returns a placeholder so the row is visible and obvious.

Dependencies: `tkinter` (bundled with Python on Windows/macOS). The tray
fallback needs `pip install pystray pillow`; without them, closing minimizes.
"""

import argparse
import collections
import threading
import time
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, ttk

import station_sender as ss

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
    """Return {label: value} rows to show under the sender status.

    Placeholder for now. To show OBS recording state, connect to obs-websocket
    here and return {"OBS": "recording" | "idle"}.
    """
    return {"OBS": "not wired up"}


SETTINGS_FIELDS = (
    ("broker", "Broker URL"),
    ("slug", "start.gg event"),
    ("dir", "MatchLogger folder"),
    ("key", "Shared key (same as the broker's OPERATOR_KEY)"),
)
REQUIRED = ("broker", "slug", "station", "dir", "key")


class Widget:
    def __init__(self, cfg, config_path):
        self.cfg = cfg
        self.config_path = config_path
        self.sender = None
        self.sender_lock = threading.Lock()
        self.running = True
        self.tray_icon = None
        self._log_rendered = -1
        self._build_sender()

        self.root = tk.Tk()
        self.root.title("MatchLogger")
        self.root.resizable(False, False)
        self._build_ui()
        self.root.protocol("WM_DELETE_WINDOW", self.on_close)

        # First run (or broken config): open Settings so it can be fixed here.
        if any(not self.cfg.get(k) for k in REQUIRED):
            self._set_status("fill in Settings to start", True)
            self.settings_frame.grid()
            self.settings_btn.config(text="Settings ▾")

        # Spawn in the bottom-right corner; after that it's a normal window —
        # the user moves it wherever, and toggles keep it where it is.
        self._place_bottom_right()

        threading.Thread(target=self._sender_loop, daemon=True).start()
        if HAVE_TRAY:
            self._start_tray()
        self._refresh_status()  # schedules itself via root.after

    # -- sender ------------------------------------------------------------
    def _build_sender(self):
        try:
            with self.sender_lock:
                self.sender = ss.build_sender(dict(self.cfg))
            return True
        except SystemExit as e:  # build_sender exits on missing config
            with self.sender_lock:
                self.sender = None
            _last.update(msg=str(e), t=time.time(), error=True)
            return False

    def _sender_loop(self):
        while self.running:
            with self.sender_lock:
                s = self.sender
            if s:
                try:
                    s.tick()
                except Exception as e:  # never let the loop die
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
        try:
            self.cfg["station"] = int(self.station_var.get())
        except (TypeError, ValueError):
            self._set_status("station must be a number", True)
            return
        if not self._build_sender():
            return
        self._save_config()
        self.event_label.config(text=self.cfg.get("slug") or "(no event set)")
        folder = self.cfg.get("dir", "")
        if folder and not Path(folder).is_dir():
            # Not fatal: the mod creates MatchLogger/ the first time the game runs.
            self._set_status("saved — folder doesn't exist yet (mod creates it on first run)", True)
        else:
            self._set_status("settings saved", False)

    def _browse_dir(self):
        current = self.setting_vars["dir"].get().strip()
        chosen = filedialog.askdirectory(
            initialdir=current or str(Path.home()),
            title="MatchLogger output folder (next to the game exe)")
        if chosen:
            self.setting_vars["dir"].set(chosen)

    def _save_config(self):
        import json
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
        self.station_var = tk.StringVar(value=str(self.cfg.get("station", "")))
        ttk.Spinbox(row, from_=0, to=99, width=4, textvariable=self.station_var).grid(row=0, column=1, **pad)
        ttk.Button(row, text="Apply", command=self.apply_station).grid(row=0, column=2, **pad)

        self.dot = tk.Canvas(frm, width=10, height=10, highlightthickness=0)
        self.dot.grid(row=1, column=0, sticky="w", padx=8)
        self._dot_id = self.dot.create_oval(1, 1, 9, 9, fill="#7fd39a", outline="")

        self.status = ttk.Label(frm, text="starting…", wraplength=260, foreground="#555")
        self.status.grid(row=2, column=0, sticky="w", padx=8, pady=(0, 4))

        self.event_label = ttk.Label(frm, text=self.cfg.get("slug") or "(no event set)",
                                     wraplength=260, foreground="#888", font=("", 8))
        self.event_label.grid(row=3, column=0, sticky="w", padx=8)

        self.extras = ttk.Label(frm, text="", foreground="#888", font=("", 8))
        self.extras.grid(row=4, column=0, sticky="w", padx=8, pady=(2, 0))

        toggles = ttk.Frame(frm)
        toggles.grid(row=5, column=0, sticky="w", pady=(6, 0))
        self.settings_btn = ttk.Button(
            toggles, text="Settings ▸",
            command=lambda: self._toggle(self.settings_frame, self.settings_btn, "Settings"))
        self.settings_btn.grid(row=0, column=0, padx=(8, 4))
        self.log_btn = ttk.Button(
            toggles, text="Log ▸",
            command=lambda: self._toggle(self.log_frame, self.log_btn, "Log"))
        self.log_btn.grid(row=0, column=1)

        # Settings panel (hidden until toggled) — every sender option, saved
        # back to the config file so nothing needs hand-editing.
        self.settings_frame = ttk.Frame(frm, padding=(8, 6, 8, 2))
        self.settings_frame.grid(row=6, column=0, sticky="we")
        self.settings_frame.grid_remove()
        self.setting_vars = {}
        for i, (key, label) in enumerate(SETTINGS_FIELDS):
            ttk.Label(self.settings_frame, text=label, font=("", 8)).grid(
                row=i * 2, column=0, columnspan=2, sticky="w")
            var = tk.StringVar(value=str(self.cfg.get(key, "") or ""))
            self.setting_vars[key] = var
            entry = ttk.Entry(self.settings_frame, width=36, textvariable=var)
            entry.grid(row=i * 2 + 1, column=0, sticky="we", pady=(0, 3))
            if key == "dir":
                ttk.Button(self.settings_frame, text="…", width=2,
                           command=self._browse_dir).grid(row=i * 2 + 1, column=1, padx=(3, 0))
        ttk.Button(self.settings_frame, text="Save", command=self.save_settings).grid(
            row=len(SETTINGS_FIELDS) * 2, column=0, sticky="w", pady=(3, 0))

        # Log panel (hidden until toggled) — the sender's log lines, so no
        # terminal is ever needed.
        self.log_frame = ttk.Frame(frm, padding=(8, 6, 8, 2))
        self.log_frame.grid(row=7, column=0, sticky="we")
        self.log_frame.grid_remove()
        self.log_text = tk.Text(self.log_frame, height=8, width=42, state="disabled",
                                font=("Courier", 9), wrap="none", relief="flat",
                                background="#f4f2f7")
        self.log_text.grid(row=0, column=0, sticky="we")

    def _toggle(self, frame, btn, label, show=None):
        visible = bool(frame.grid_info())
        show = (not visible) if show is None else show
        if show == visible:
            return
        # Anchor the bottom edge: panels expand upward, so a window sitting in
        # the corner (or wherever the user moved it) never grows off-screen.
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
            pystray.MenuItem("Quit", self._tray_quit),
        )
        self.tray_icon = pystray.Icon("matchlogger", self._tray_image(), "MatchLogger station", menu)
        threading.Thread(target=self.tray_icon.run, daemon=True).start()

    def _tray_show(self, *_):
        self.root.after(0, self.root.deiconify)

    def _tray_quit(self, *_):
        self.root.after(0, self.quit)

    def on_close(self):
        if HAVE_TRAY:
            self.root.withdraw()  # hide to tray; sender keeps running
        else:
            self.root.iconify()   # no tray available → just minimize

    def quit(self):
        self.running = False
        if self.tray_icon:
            self.tray_icon.stop()
        self.root.destroy()

    def run(self):
        self.root.mainloop()


def main(argv=None):
    p = argparse.ArgumentParser(description="MatchLogger station widget.")
    p.add_argument("--config", default="config.json")
    # allow the same overrides as the headless sender
    for f in ("broker", "slug", "dir", "key"):
        p.add_argument("--" + f)
    p.add_argument("--station", type=int)
    args = p.parse_args(argv)

    # A missing config file is fine: the widget starts with Settings open and
    # creates the file on Save. Resolve it next to this script so double-click
    # launches (cwd = who-knows-where) still find/create the same config.
    config_path = args.config
    if not Path(config_path).is_absolute():
        config_path = str(Path(__file__).resolve().parent / config_path)

    cfg = ss.load_config(config_path if Path(config_path).exists() else None)
    for f in ("broker", "slug", "dir", "key", "station"):
        v = getattr(args, f)
        if v is not None:
            cfg[f] = v
    cfg.setdefault("broker", DEFAULT_BROKER)
    Widget(cfg, config_path).run()


if __name__ == "__main__":
    main()
