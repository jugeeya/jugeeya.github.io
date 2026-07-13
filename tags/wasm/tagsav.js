// Friendly wrapper around the r2tag WebAssembly module (compiled from the same
// `uesave`-based Rust the desktop tool uses). Lets the site read a `.sav`, split
// out individual `.r2tag` tags, and merge tags back into a save — all in-browser.
//
// All byte arguments/returns are Uint8Array.

import init, {
  get_tag_names,
  save_version,
  tag_name_in,
  export_tag,
  import_tags,
} from './r2tag_wasm.js';
// tag_json is newer than some deployed builds — pull it via the namespace so a
// not-yet-rebuilt .wasm doesn't break this module's import linking (named
// imports of a missing export are a hard error; a missing namespace key is just
// undefined, which tagJson() handles).
import * as _wasmAll from './r2tag_wasm.js';

let ready = null;

// Instantiate the wasm once. The .wasm sits next to r2tag_wasm.js.
function ensureWasm() {
  if (!ready) {
    ready = init({ module_or_path: new URL('./r2tag_wasm_bg.wasm', import.meta.url) });
  }
  return ready;
}

/** Custom tag names in a .sav (Uint8Array) -> string[]. */
export async function getTagNames(savBytes) {
  await ensureWasm();
  return get_tag_names(savBytes);
}

/** Save-format version of a .sav or .r2tag -> number | undefined. */
export async function saveVersion(bytes) {
  await ensureWasm();
  return save_version(bytes);
}

/** Tag name stored inside a .r2tag -> string. */
export async function tagNameIn(r2tagBytes) {
  await ensureWasm();
  return tag_name_in(r2tagBytes);
}

/** Full parsed save tree (the `root` properties) of a .sav/.r2tag -> object. */
export async function tagJson(bytes) {
  await ensureWasm();
  if (typeof _wasmAll.tag_json !== 'function') {
    throw new Error('this feature needs an updated build; please try again shortly');
  }
  return _wasmAll.tag_json(bytes);
}

/** Produce a one-tag .r2tag (Uint8Array) from a loaded save. */
export async function exportTag(savBytes, tagName) {
  await ensureWasm();
  return export_tag(savBytes, tagName);
}

/**
 * Merge .r2tag tags into a save. The save's first tag always stays in slot 0
 * (a same-named item still overwrites its content, subject to `overwrite`, it
 * just never moves); everything installed lands directly after it, then every
 * other pre-existing tag, in its original order. An item's `rename`, if given,
 * replaces its in-save TagName — used to keep two same-named tags installed
 * together from colliding (e.g. rename to each one's start.gg handle).
 * @param {Uint8Array} savBytes destination save
 * @param {{bytes: Uint8Array, overwrite: boolean, rename?: string}[]} items tags to merge
 * @returns {{sav: Uint8Array, imported: string[], skipped: string[], incompatible: string[]}}
 */
export async function importTags(savBytes, items) {
  await ensureWasm();
  return import_tags(savBytes, items);
}
