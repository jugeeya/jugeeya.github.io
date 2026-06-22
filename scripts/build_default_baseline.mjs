// Regenerate tags/control-defaults.json — the default baseline the tags page
// diffs against. (It lives in tags/, not tags/data/, so the tag-submission
// tooling that watches tags/data/** doesn't treat it as a tag.)
//
// Lacking a clean default-tag export, the baseline is reconstructed from a known
// tag (JUGZ) with its author-confirmed customizations reverted to default (see
// DEFAULT_OVERRIDES). It uses the SAME extractDigest() the browser runs, so the
// baseline and live digests can't drift. If a true default export appears, point
// BASELINE_TAG at it and empty DEFAULT_OVERRIDES.
//
// Parsing GVAS needs the native ../tagtool helper (same `uesave` as the WASM):
//     cd tagtool && CARGO_TARGET_DIR=/tmp/tagtool-target cargo build --release
//     TAGDUMP=/tmp/tagtool-target/release/tagdump npm run build:baseline
//
// (Or pass an already-dumped root JSON via BASELINE_JSON=<path> to skip tagdump.)

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { extractDigest } from '../tags/tagdiff.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA = path.join(ROOT, 'tags', 'data');
const BASELINE_TAG = 'jugz-6192f6f1.r2tag.zip';
const TAGDUMP = process.env.TAGDUMP || '/tmp/tagtool-target/release/tagdump';

// Fields to revert from the baseline tag back to their real defaults.
const DEFAULT_OVERRIDES = {
    settings: {
        RollSetting: 'Default',
        RightStickSetting: 'Strong',
        AirParrySetting: 'Nspecial',
        AirGrabSetting: 'Airdodge',
    },
    // Xbox sticks ship at 1.0; the baseline tag raised them. Other pads' defaults
    // (Switch 1.2, GameCube 1.3) are left as-is.
    controllerSensitivity: { Xbox360: 1.0, XboxOne: 1.0 },
    // Binding reverts: default keyboard Jump is Space only; the baseline tag
    // added O. (keys must match the stored label form: "<KeyName>[(xScale)]".)
    bindings: { Keyboard: { actions: { Jump: ['SpaceBar'] } } },
};

function baselineRoot() {
    if (process.env.BASELINE_JSON) {
        return JSON.parse(fs.readFileSync(process.env.BASELINE_JSON, 'utf8'));
    }
    // Pull the single .r2tag out of the zip (stored or deflated) and run tagdump.
    const zip = fs.readFileSync(path.join(DATA, BASELINE_TAG));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-'));
    const r2 = path.join(tmp, 'tag.r2tag');
    fs.writeFileSync(r2, extractSingleZipEntry(zip));
    const json = execFileSync(TAGDUMP, [r2], { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
    fs.rmSync(tmp, { recursive: true, force: true });
    return JSON.parse(json);
}

// Minimal single-entry ZIP reader (stored or deflate) — avoids a dep.
function extractSingleZipEntry(buf) {
    // Find the first local file header (PK\x03\x04).
    const sig = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    if (sig !== 0) throw new Error('unexpected zip layout');
    const method = buf.readUInt16LE(8);
    const compSize = buf.readUInt32LE(18);
    const nameLen = buf.readUInt16LE(26);
    const extraLen = buf.readUInt16LE(28);
    const start = 30 + nameLen + extraLen;
    const data = buf.subarray(start, start + compSize);
    if (method === 0) return data;              // stored
    if (method === 8) return inflateRawSync(data); // deflate
    throw new Error(`unsupported zip method ${method}`);
}

function applyOverrides(digest) {
    Object.assign(digest.settings, DEFAULT_OVERRIDES.settings);
    for (const [type, val] of Object.entries(DEFAULT_OVERRIDES.controllerSensitivity)) {
        const c = digest.controllers[type];
        if (c && c.sensitivity) {
            const n = c.sensitivity.values?.length || 1;
            c.sensitivity = { max: val, values: Array(n).fill(val) };
        }
    }
    for (const [type, kinds] of Object.entries(DEFAULT_OVERRIDES.bindings || {})) {
        const c = digest.controllers[type];
        if (!c) continue;
        for (const [kind, names] of Object.entries(kinds)) {
            for (const [name, keys] of Object.entries(names)) {
                c[kind][name] = [...keys].sort();
            }
        }
    }
    return digest;
}

const digest = applyOverrides(extractDigest(baselineRoot()));
const outPath = path.join(ROOT, 'tags', 'control-defaults.json');
fs.writeFileSync(outPath, JSON.stringify(digest, null, 1) + '\n');
console.log(`Wrote tags/control-defaults.json from ${BASELINE_TAG} (overrides applied).`);
