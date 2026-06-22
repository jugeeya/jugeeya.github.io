# r2tag-wasm

The in-browser save engine for the tags page. Wraps the same `uesave`-based
logic the desktop tool uses (reading/writing the Rivals II GVAS save) and
compiles it to WebAssembly so the website can read a `.sav`, split out individual
`.r2tag` tags, and merge tags back into a save — all client-side, nothing
uploaded.

The built artifacts are committed at `../tags/wasm/` (GitHub Pages has no build
step), so you only need to rebuild when this crate changes.

## Rebuild

Requires the `wasm32-unknown-unknown` target and a `wasm-bindgen` CLI matching
the `wasm-bindgen` crate version in `Cargo.toml`:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --locked   # must match Cargo.toml's wasm-bindgen

# from this directory:
cargo build --target wasm32-unknown-unknown --release
wasm-bindgen --target web --out-dir pkg \
  target/wasm32-unknown-unknown/release/r2tag_wasm.wasm

# publish the artifacts the site loads
cp pkg/r2tag_wasm.js pkg/r2tag_wasm_bg.wasm ../tags/wasm/
```

(`wasm-pack` would normally wrap these steps, but it currently requires a newer
rustc than this repo's toolchain; the two commands above do the same job.)

## Exports

`tagsav.js` (in `../tags/wasm/`) is a small wrapper over these:

- `get_tag_names(sav)` → custom tag names in a save
- `save_version(bytes)` → save-format version of a `.sav`/`.r2tag`
- `tag_name_in(r2tag)` → the tag name inside a `.r2tag`
- `tag_json(bytes)` → the full parsed save tree as a JS object (used by the tags
  page to diff a tag's control settings against the default)
- `export_tag(sav, name)` → one-tag `.r2tag` bytes
- `import_tags(sav, items)` → merged save bytes + imported/skipped/incompatible

The committed artifacts under `../tags/wasm/` are rebuilt automatically in CI
(`.github/workflows/build-wasm.yml`) whenever this crate changes, so you normally
don't need to rebuild by hand.
