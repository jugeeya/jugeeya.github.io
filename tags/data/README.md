# Shared tag storage

Holds the published tags and the manifest the Tag Sharing page reads. Served
statically by GitHub Pages.

## Files

Each published tag is two files, keyed by a unique `<slug>`:

- `<slug>.r2tag.zip` — a zip containing exactly one `*.r2tag` (a GVAS save).
- `<slug>.json` — sidecar metadata for that tag.

`index.json` is **generated** from the sidecars by
`../../scripts/build_tags_manifest.py` — never edit it by hand, and never
include it in a submission.

### Sidecar format (`<slug>.json`)

```json
{
  "name": "JUGZ!",
  "author": "jugeeya",
  "file": "jugz-ab12cd.r2tag.zip",
  "uploaded": "2026-06-17T00:00:00Z"
}
```

- `name` — the tag's display name (1–64 chars).
- `author` — who shared it (optional, ≤64 chars).
- `file` — the matching `<slug>.r2tag.zip` in this folder.
- `uploaded` — ISO timestamp.

### Manifest (`index.json`, generated)

```json
{
  "version": 1,
  "updated": "2026-06-17T00:00:00Z",
  "tags": [ { "name": "...", "author": "...", "file": "...", "uploaded": "..." } ]
}
```

The page (`../tags.js`) fetches `index.json`, lists each entry, and links
`data/<file>` for download.

## How tags get here

Submissions go through the broker Worker + a GitHub App, which opens a PR; the
`validate-and-merge-tags` Action validates and auto-merges it. See
`../../broker/README.md`. To add one manually: drop the `<slug>.r2tag.zip` +
`<slug>.json` here and run `python scripts/build_tags_manifest.py` from the repo
root.

Tags compress extremely well (~20 KB zipped), so storage cost is negligible.
