# Double-click launcher for Windows: .pyw files open with pythonw.exe, which
# has no terminal attached — the widget's Log panel replaces it.
#
# In the packaged download this is the only file at the top level; the actual
# implementation sits in _internal/ next to it, out of the way. If _internal/
# isn't there (e.g. running straight from the source tree during development,
# where station_widget.py sits flat alongside this file), it falls back to
# importing station_widget from this same folder instead.
import sys
from pathlib import Path

_internal = Path(__file__).resolve().parent / "_internal"
if _internal.is_dir():
    sys.path.insert(0, str(_internal))

import station_widget

station_widget.main()
