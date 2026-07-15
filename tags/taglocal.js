// Reading .r2tag files the user already has on disk (single files, .r2tag.zip
// bundles, or a whole folder of either) into { name, fileName, bytes } entries.
//
// Shared between the online tags page and the generated offline installer: the
// offline build inlines this file after stripping the `export ` keywords, so
// keep it dependency-free — everything it needs (the WASM `tagNameIn` reader
// and JSZip) is passed in via `deps`.

/**
 * Read a list of File objects into tag entries.
 * @param {Iterable<File>} files picked files (or every file of a picked folder)
 * @param {{ tagNameIn: (bytes: Uint8Array) => Promise<string>|string,
 *           JSZip: any }} deps
 * @returns {Promise<{tags: {name: string, fileName: string, bytes: Uint8Array}[],
 *                    errors: {fileName: string, message: string}[],
 *                    ignored: number}>}
 *   `ignored` counts files that aren't .r2tag/.zip at all (folder picks sweep
 *   in everything); unreadable candidates land in `errors` instead.
 */
export async function readTagFiles(files, deps) {
    const { tagNameIn, JSZip } = deps;
    const tags = [];
    const errors = [];
    let ignored = 0;

    // One .r2tag payload -> a tag entry (the WASM read doubles as validation).
    async function addCandidate(fileName, bytes) {
        try {
            const name = await tagNameIn(bytes);
            tags.push({ name, fileName, bytes });
        } catch (err) {
            errors.push({ fileName, message: String(err && err.message || err) });
        }
    }

    for (const file of files) {
        const lower = file.name.toLowerCase();
        try {
            if (lower.endsWith('.r2tag')) {
                await addCandidate(file.name, new Uint8Array(await file.arrayBuffer()));
            } else if (lower.endsWith('.zip')) {
                const zip = await JSZip.loadAsync(await file.arrayBuffer());
                const entries = Object.values(zip.files).filter(
                    f => !f.dir && f.name.toLowerCase().endsWith('.r2tag'));
                if (!entries.length) {
                    errors.push({ fileName: file.name, message: 'no .r2tag inside' });
                    continue;
                }
                for (const entry of entries) {
                    await addCandidate(`${file.name} › ${entry.name}`,
                        await entry.async('uint8array'));
                }
            } else {
                ignored++;
            }
        } catch (err) {
            errors.push({ fileName: file.name, message: String(err && err.message || err) });
        }
    }

    return { tags, errors, ignored };
}

/**
 * Collect the File objects out of a drag-and-drop DataTransfer, descending
 * into dropped folders where the browser exposes them (webkitGetAsEntry).
 * Must be called synchronously from the drop handler — a DataTransfer's items
 * are only readable during the event. Falls back to dataTransfer.files when
 * the entry API isn't available. Depth and file count are capped so a stray
 * drop of an enormous tree can't wedge the page.
 * @param {DataTransfer} dataTransfer
 * @returns {Promise<File[]>}
 */
export async function filesFromDataTransfer(dataTransfer) {
    const MAX_DEPTH = 8;
    const MAX_FILES = 2000;
    const out = [];
    const entries = [];

    // Synchronous part: snapshot entries/files before the event goes stale.
    const items = dataTransfer && dataTransfer.items;
    if (items) {
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.kind !== 'file') continue;
            const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
            if (entry) {
                entries.push(entry);
            } else {
                const f = item.getAsFile && item.getAsFile();
                if (f) out.push(f);
            }
        }
    }
    if (!entries.length && !out.length) {
        return [...((dataTransfer && dataTransfer.files) || [])];
    }

    async function walk(entry, depth) {
        if (out.length >= MAX_FILES) return;
        if (entry.isFile) {
            const file = await new Promise((resolve) =>
                entry.file(resolve, () => resolve(null)));
            if (file) out.push(file);
        } else if (entry.isDirectory && depth < MAX_DEPTH) {
            const reader = entry.createReader();
            // readEntries returns results in batches; keep reading until empty.
            for (;;) {
                const batch = await new Promise((resolve) =>
                    reader.readEntries(resolve, () => resolve([])));
                if (!batch.length) break;
                for (const child of batch) {
                    await walk(child, depth + 1);
                    if (out.length >= MAX_FILES) return;
                }
            }
        }
    }

    for (const entry of entries) {
        await walk(entry, 0);
        if (out.length >= MAX_FILES) break;
    }
    return out;
}
