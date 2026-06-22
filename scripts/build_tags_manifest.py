#!/usr/bin/env python3
"""Regenerate tags/data/index.json from the per-tag sidecar files.

The manifest is always rebuilt from the trusted sidecars (never contributed
directly), so a submission can't tamper with other entries. Run from the repo
root; writes tags/data/index.json.
"""
import datetime
import glob
import json
import os

DATA_DIR = "tags/data"
MANIFEST = os.path.join(DATA_DIR, "index.json")


def main():
    entries = []
    for path in sorted(glob.glob(os.path.join(DATA_DIR, "*.json"))):
        if os.path.basename(path) == "index.json":
            continue
        # Only per-tag sidecars (which pair with a <stem>.r2tag.zip) are tags;
        # skip other data files like control-settings.json / control-defaults.json.
        stem = os.path.basename(path)[:-len(".json")]
        if not os.path.exists(os.path.join(DATA_DIR, f"{stem}.r2tag.zip")):
            continue
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        entry = {
            "name": d["name"],
            "author": d.get("author", ""),
            "file": d.get("file", f"{stem}.r2tag.zip"),
            "uploaded": d.get("uploaded"),
        }
        sgg = d.get("startgg")
        if isinstance(sgg, dict) and sgg.get("slug"):
            entry["startgg"] = {"slug": sgg["slug"], "tag": sgg.get("tag", "")}
        entries.append(entry)

    # Newest first; fall back to name for stable ordering.
    entries.sort(key=lambda e: (e.get("uploaded") or "", e["name"]), reverse=True)

    manifest = {
        "version": 1,
        "updated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "tags": entries,
    }

    with open(MANIFEST, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")

    print(f"Wrote {MANIFEST} with {len(entries)} tag(s).")


if __name__ == "__main__":
    main()
