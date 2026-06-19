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

/** Produce a one-tag .r2tag (Uint8Array) from a loaded save. */
export async function exportTag(savBytes, tagName) {
  await ensureWasm();
  return export_tag(savBytes, tagName);
}

/**
 * Merge .r2tag tags into a save.
 * @param {Uint8Array} savBytes destination save
 * @param {{bytes: Uint8Array, overwrite: boolean}[]} items tags to merge
 * @returns {{sav: Uint8Array, imported: string[], skipped: string[], incompatible: string[]}}
 */
export async function importTags(savBytes, items) {
  await ensureWasm();
  return import_tags(savBytes, items);
}
