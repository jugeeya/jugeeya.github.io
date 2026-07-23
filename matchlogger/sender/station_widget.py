#!/usr/bin/env python3
"""MatchLogger station widget — a small always-on-top corner window that runs
the station sender, lets you set the station number, and shows live status.

It wraps `station_sender.py` (the headless core does the real work): this file
is just a face on it. Closing the window sends it to the system tray (if
`pystray` + `pillow` are installed) rather than quitting.

  python station_widget.py --config config.json

The station number is editable in the window and written back to the config
file. Everything else (broker, event slug, folder) comes from the config, the
same as the headless sender.

Extending it: `poll_extras()` returns a dict of extra status rows shown under
the sender status — e.g. wire it to obs-websocket to show "OBS: recording".
Right now it returns a placeholder so the row is visible and obvious.

Dependencies: `tkinter` (bundled with Python on Windows/macOS). The tray
fallback needs `pip install pystray pillow`; without them, closing minimizes.
"""

import argparse
import threading
import time
import tkinter as tk
from tkinter import ttk

import station_sender as ss

# Optional tray support.
try:
    import pystray
    from PIL import Image, ImageDraw
    HAVE_TRAY = True
except Exception:
    HAVE_TRAY = False

POLL_SEC = 2.0

# Capture the sender's last log line for the status row (non-invasive: the core
# stays a plain module).
_last = {"msg": "starting…", "t": time.time(), "error": False}
_orig_log = ss.log
def _cap_log(msg):
    _last.update(msg=msg, t=time.time(), error=("fail" in msg.lower() or "error" in msg.lower()))
    _orig_log(msg)
ss.log = _cap_log


def poll_extras():
    """Return {label: value} rows to show under the sender status.

    Placeholder for now. To show OBS recording state, connect to obs-websocket
    here and return {"OBS": "recording" | "idle"}.
    """
    return {"OBS": "not wired up"}


class Widget:
    def __init__(self, cfg, config_path):
        self.cfg = cfg
        self.config_path = config_path
        self.sender = None
        self.sender_lock = threading.Lock()
        self.running = True
        self.tray_icon = None
        self._build_sender()

        self.root = tk.Tk()
        self.root.title("MatchLogger")
        self.root.attributes("-topmost", True)
        self.root.resizable(False, False)
        self._build_ui()
        self._place_bottom_right(260, 150)
        self.root.protocol("WM_DELETE_WINDOW", self.on_close)

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

        self.status = ttk.Label(frm, text="starting…", wraplength=230, foreground="#555")
        self.status.grid(row=2, column=0, sticky="w", padx=8, pady=(0, 4))

        ev = self.cfg.get("slug", "") or "(no event set)"
        ttk.Label(frm, text=ev, wraplength=230, foreground="#888", font=("", 8)).grid(
            row=3, column=0, sticky="w", padx=8)

        self.extras = ttk.Label(frm, text="", foreground="#888", font=("", 8))
        self.extras.grid(row=4, column=0, sticky="w", padx=8, pady=(2, 0))

    def _place_bottom_right(self, w, h):
        self.root.update_idletasks()
        sw = self.root.winfo_screenwidth()
        sh = self.root.winfo_screenheight()
        self.root.geometry(f"{w}x{h}+{sw - w - 24}+{sh - h - 60}")

    def _set_status(self, msg, error):
        _last.update(msg=msg, t=time.time(), error=error)

    def _refresh_status(self):
        age = int(time.time() - _last["t"])
        ago = "just now" if age < 2 else f"{age}s ago"
        self.status.config(text=f"{_last['msg']}  ·  {ago}")
        self.dot.itemconfig(self._dot_id, fill="#ffb4ab" if _last["error"] else "#7fd39a")
        rows = poll_extras()
        self.extras.config(text="   ".join(f"{k}: {v}" for k, v in rows.items()))
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

    cfg = ss.load_config(args.config)
    for f in ("broker", "slug", "dir", "key", "station"):
        v = getattr(args, f)
        if v is not None:
            cfg[f] = v
    Widget(cfg, args.config).run()


if __name__ == "__main__":
    main()
