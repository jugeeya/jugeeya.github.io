// Builds demo/fixtures/demo-save.sav from a few published tags, so the demo has
// a multi-tag save to load. Reuses the site's committed WASM (the same uesave
// logic) to merge tags, and fflate to unzip the published .r2tag.zip files.
//
//   node generate-fixture.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import init, { import_tags, get_tag_names } from '../tags/wasm/r2tag_wasm.js';

const ORIGIN = process.env.ORIGIN || 'https://jugeeya.github.io';
const OUT = fileURLToPath(new URL('./fixtures/demo-save.sav', import.meta.url));
const MAX = 3;

const wasmBytes = readFileSync(new URL('../tags/wasm/r2tag_wasm_bg.wasm', import.meta.url));
await init({ module_or_path: wasmBytes });

const fetchBytes = async (url) => new Uint8Array(await (await fetch(url)).arrayBuffer());

// Unzip a published .r2tag.zip and return the inner .r2tag bytes.
function r2tagFromZip(zipBytes) {
  const files = unzipSync(zipBytes);
  const name = Object.keys(files).find((n) => n.toLowerCase().endsWith('.r2tag'));
  if (!name) throw new Error('no .r2tag inside zip');
  return files[name];
}

const index = await (await fetch(`${ORIGIN}/tags/data/index.json`)).json();
const files = (index.tags || []).map((t) => t.file).slice(0, MAX);
if (!files.length) throw new Error('no published tags to build a fixture from');

const tags = [];
for (const f of files) {
  tags.push(r2tagFromZip(await fetchBytes(`${ORIGIN}/tags/data/${f}`)));
}

// Use the first tag's save as the base, then merge the rest in.
let sav = tags[0];
if (tags.length > 1) {
  const rep = import_tags(sav, tags.slice(1).map((bytes) => ({ bytes, overwrite: true })));
  sav = rep.sav;
}

mkdirSync(fileURLToPath(new URL('./fixtures/', import.meta.url)), { recursive: true });
writeFileSync(OUT, sav);
console.log(`Wrote ${OUT} with tags: ${JSON.stringify(get_tag_names(sav))}`);
