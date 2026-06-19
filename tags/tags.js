// Tag-sharing page.
//
// Browsing reads a static manifest (data/index.json) served by GitHub Pages.
//
// Submitting sends the selected .r2tag.zip file(s) to a broker (a small
// Cloudflare Worker) which opens a pull request on the repo via a GitHub App.
// A GitHub Action then validates the PR and auto-merges it if it's benign, at
// which point the tag appears in the browse list below.
//
// Set UPLOAD_ENDPOINT to your deployed Worker URL to turn submitting on. While
// it's null the page is browse-only and Submit explains it isn't wired up.
// See broker/README.md for how to stand up the Worker + GitHub App.

import { getTagNames, exportTag, importTags } from './wasm/tagsav.js';

const UPLOAD_ENDPOINT = 'https://r2tag-broker.jdsambasivam.workers.dev';
const MANIFEST_URL = 'data/index.json';
const ACCEPTED_EXTENSION = '.zip'; // a zipped .r2tag; contents validated server-side
const MAX_FILE_BYTES = 512 * 1024; // a zipped tag is ~20 KB; this is generous
const REPO = 'jugeeya/jugeeya.github.io';      // for polling public PR status
const PENDING_KEY = 'r2tag_pending_submissions'; // localStorage key
const POLL_INTERVAL_MS = 45000;

// State
// Each entry is { file, picker } where picker.get() is the tag's own start.gg
// link ({ slug, tag } | null) — every submitted tag carries its own.
let selectedFiles = [];
let allTags = [];
let tagSearchQuery = '';

// DOM
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const fileListEl = document.getElementById('fileList');
const authorInput = document.getElementById('authorInput');
const submitButton = document.getElementById('submitButton');
const clearButton = document.getElementById('clearButton');
const uploadStatus = document.getElementById('uploadStatus');
const tagBrowser = document.getElementById('tagBrowser');
const pendingPanel = document.getElementById('pendingPanel');
const pendingList = document.getElementById('pendingList');
const bracketInput = document.getElementById('bracketInput');
const bracketGo = document.getElementById('bracketGo');
const bracketStatus = document.getElementById('bracketStatus');
const savButton = document.getElementById('savButton');
const savInput = document.getElementById('savInput');
const savPanel = document.getElementById('savPanel');
const importSavInput = document.getElementById('importSavInput');
const importOverwrite = document.getElementById('importOverwrite');
const importStatus = document.getElementById('importStatus');

// A loaded .sav: its raw bytes + the custom tag names found in it.
let loadedSav = null;

// ---- Helpers --------------------------------------------------------------

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function validateFile(file) {
    if (!file.name.toLowerCase().endsWith(ACCEPTED_EXTENSION)) {
        return { ok: false, message: `Must be a ${ACCEPTED_EXTENSION}` };
    }
    if (file.size > MAX_FILE_BYTES) {
        return { ok: false, message: `Too large (${formatBytes(file.size)})` };
    }
    return { ok: true, message: 'Ready' };
}

function setStatus(message, kind = '') {
    uploadStatus.innerHTML = message;
    uploadStatus.className = `upload-status${kind ? ' ' + kind : ''}`;
}

// ---- File selection -------------------------------------------------------

function addFiles(files) {
    for (const file of files) {
        // De-dupe by name + size so dropping twice doesn't stack copies.
        const dup = selectedFiles.some(e => e.file.name === file.name && e.file.size === file.size);
        if (dup) continue;
        selectedFiles.push({ file, picker: createStartggPicker(updateSubmitState) });
    }
    renderFileList();
}

function removeFile(index) {
    selectedFiles.splice(index, 1);
    renderFileList();
}

function renderFileList() {
    fileListEl.innerHTML = '';

    selectedFiles.forEach((entry, index) => {
        const { ok, message } = validateFile(entry.file);

        const li = document.createElement('li');
        li.className = 'file-item';

        const top = document.createElement('div');
        top.className = 'file-row-top';

        const left = document.createElement('div');
        left.innerHTML =
            `<div>${escapeHtml(entry.file.name)}</div>` +
            `<div class="file-meta">${formatBytes(entry.file.size)} · ` +
            `<span class="file-status ${ok ? 'ok' : 'warn'}">${message}</span></div>`;

        const remove = document.createElement('button');
        remove.className = 'remove-file';
        remove.textContent = '✕';
        remove.title = 'Remove';
        remove.addEventListener('click', () => removeFile(index));

        top.appendChild(left);
        top.appendChild(remove);

        // Each tag gets its own start.gg picker.
        const sgg = document.createElement('div');
        sgg.className = 'file-row-sgg';
        sgg.appendChild(entry.picker.root);

        li.appendChild(top);
        li.appendChild(sgg);
        fileListEl.appendChild(li);
    });

    updateSubmitState();
    clearButton.disabled = selectedFiles.length === 0;
    if (selectedFiles.length === 0) setStatus('');
}

function updateSubmitState() {
    const valid = selectedFiles.filter(e => validateFile(e.file).ok);
    const allLinked = valid.length > 0 && valid.every(e => e.picker.get());
    submitButton.disabled = !allLinked;
    if (valid.length > 0 && !allLinked && !uploadStatus.textContent) {
        setStatus('Link a start.gg account for each tag to submit.', 'warn');
    } else if (uploadStatus.classList.contains('warn')) {
        setStatus('');
    }
}

// ---- Submit ---------------------------------------------------------------

async function submitTags() {
    const valid = selectedFiles.filter(e => validateFile(e.file).ok);
    if (valid.length === 0) return;
    if (!valid.every(e => e.picker.get())) {
        setStatus('Link a start.gg account for each tag before submitting.', 'error');
        return;
    }

    if (!UPLOAD_ENDPOINT) {
        setStatus(
            'Submitting isn’t connected yet — this page is a scaffold. ' +
            'Set UPLOAD_ENDPOINT in tags.js to your broker Worker to enable it.',
            'error'
        );
        return;
    }

    setStatus('Submitting…');
    submitButton.disabled = true;
    try {
        const form = new FormData();
        valid.forEach(e => {
            const link = e.picker.get();
            form.append('tags', e.file, e.file.name);
            form.append('startgg_slug', link.slug);
            form.append('startgg_tag', link.tag || '');
        });
        form.append('author', (authorInput?.value || '').trim());

        const res = await fetch(UPLOAD_ENDPOINT, { method: 'POST', body: form });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);

        const names = valid.map(e => e.file.name.replace(/(\.r2tag)?\.zip$/i, ''));
        if (data.number) {
            recordSubmission({ number: data.number, url: data.pr, names });
        }

        const prLink = data.pr
            ? ` <a href="${data.pr}" target="_blank" rel="noopener">PR #${data.number}</a>`
            : '';
        setStatus(
            `Submitted ${valid.length} tag(s).${prLink} Tracking it under “Your submissions” below.`,
            'success'
        );
        selectedFiles = [];
        renderFileList();
        // Poll the PR so the status updates from “In review” to “Published”.
        refreshPendingStatuses();
    } catch (err) {
        console.error('Submission failed:', err);
        setStatus(`Submission failed: ${err.message}`, 'error');
    } finally {
        submitButton.disabled = false;
    }
}

// ---- Browse shared tags ---------------------------------------------------

async function loadManifest() {
    try {
        const res = await fetch(MANIFEST_URL, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const manifest = await res.json();
        allTags = Array.isArray(manifest.tags) ? manifest.tags : [];
        renderTagBrowser();
    } catch (err) {
        console.error('Could not load tag manifest:', err);
        allTags = [];
        tagBrowser.innerHTML = '<p class="muted">No shared tags yet.</p>';
    }
}

function tagDisplayName(tag) {
    return tag.name || tag.file || 'Untitled tag';
}

function filteredTags() {
    const query = tagSearchQuery.trim().toLowerCase();
    if (!query) return allTags;
    return allTags.filter(tag => tagDisplayName(tag).toLowerCase().includes(query));
}

function getSelectedTagFiles() {
    return [...tagBrowser.querySelectorAll('.tag-checkbox:checked')]
        .map(cb => cb.value);
}

function updateDownloadButton() {
    const btn = tagBrowser.querySelector('#downloadSelected');
    if (!btn) return;
    const count = getSelectedTagFiles().length;
    btn.disabled = count === 0;
    btn.textContent = count === 0 ? 'Download tags'
        : count === 1 ? 'Download 1 tag'
        : `Download ${count} tags`;

    const importBtn = tagBrowser.querySelector('#importSelected');
    if (importBtn) {
        importBtn.disabled = count === 0;
        importBtn.textContent = count <= 1 ? 'Import to save' : `Import ${count} to save`;
    }
}

// Builds the browser chrome (search box, action buttons, list container) once
// and wires its listeners. The list itself is (re)drawn by renderTagList — so
// typing in the search box never recreates the input and never drops focus.
function renderTagBrowser() {
    if (!allTags.length) {
        tagBrowser.innerHTML = '<p class="muted">No shared tags yet — be the first to upload one.</p>';
        return;
    }

    tagBrowser.innerHTML =
        '<div class="tag-browser-toolbar">' +
        '<input type="search" id="tagSearch" class="tag-search" ' +
        'placeholder="Search tags…" autocomplete="off">' +
        '<div class="tag-browser-actions">' +
        '<button type="button" id="selectAllTags" class="linkish">Select all</button>' +
        '<span class="tag-action-sep">·</span>' +
        '<button type="button" id="clearTagSelection" class="linkish">Clear</button>' +
        '<button type="button" id="downloadSelected" disabled>Download tags</button>' +
        '<button type="button" id="importSelected" class="secondary" disabled>Import to save</button>' +
        '</div></div>' +
        '<ul id="tagList" class="tag-list"></ul>';

    const searchInput = tagBrowser.querySelector('#tagSearch');
    searchInput.value = tagSearchQuery;
    searchInput.addEventListener('input', () => {
        tagSearchQuery = searchInput.value;
        renderTagList(); // redraw only the list; keep the search box (and focus)
    });

    tagBrowser.querySelector('#selectAllTags').addEventListener('click', () => {
        tagBrowser.querySelectorAll('.tag-checkbox').forEach(cb => { cb.checked = true; });
        updateDownloadButton();
    });

    tagBrowser.querySelector('#clearTagSelection').addEventListener('click', () => {
        tagBrowser.querySelectorAll('.tag-checkbox').forEach(cb => { cb.checked = false; });
        updateDownloadButton();
    });

    tagBrowser.querySelector('#downloadSelected').addEventListener('click', downloadSelectedTags);
    tagBrowser.querySelector('#importSelected').addEventListener('click', startImportToSave);

    renderTagList();
}

// Redraws just the <ul#tagList> for the current search filter, preserving the
// selection of any items that remain visible.
function renderTagList() {
    const list = tagBrowser.querySelector('#tagList');
    if (!list) return;

    const previouslySelected = new Set(getSelectedTagFiles());
    const visible = filteredTags();

    list.innerHTML = '';

    if (!visible.length) {
        list.innerHTML = '<li class="tag-list-empty muted">No tags match your search.</li>';
    } else {
        visible.forEach(tag => {
            const file = tag.file || '';
            const li = document.createElement('li');
            li.className = 'tag-list-item';

            const label = document.createElement('label');
            label.className = 'tag-list-label';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'tag-checkbox';
            checkbox.value = file;
            checkbox.checked = previouslySelected.has(file);
            checkbox.addEventListener('change', updateDownloadButton);

            const name = document.createElement('span');
            name.className = 'tag-list-name';
            name.textContent = tagDisplayName(tag);

            label.appendChild(checkbox);
            label.appendChild(name);
            li.appendChild(label);

            if (tag.startgg && tag.startgg.slug) {
                const a = document.createElement('a');
                a.className = 'tag-sgg-link';
                a.href = `https://www.start.gg/${tag.startgg.slug}`;
                a.target = '_blank';
                a.rel = 'noopener';
                a.textContent = tag.startgg.tag ? `@${tag.startgg.tag}` : 'start.gg';
                a.title = 'View start.gg profile';
                li.appendChild(a);
            }

            list.appendChild(li);
        });
    }

    updateDownloadButton();
}

async function downloadSelectedTags() {
    const files = getSelectedTagFiles();
    if (!files.length) return;

    const tags = files
        .map(file => allTags.find(t => t.file === file))
        .filter(Boolean);
    if (!tags.length) return;

    const btn = tagBrowser.querySelector('#downloadSelected');
    const prevText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Downloading…';

    try {
        if (tags.length === 1) {
            triggerDownload(`data/${tags[0].file}`, tags[0].file);
            return;
        }

        const zip = new JSZip();
        await Promise.all(tags.map(async (tag) => {
            const res = await fetch(`data/${tag.file}`);
            if (!res.ok) throw new Error(`Could not fetch ${tag.file}`);
            zip.file(tag.file, await res.blob());
        }));

        const blob = await zip.generateAsync({ type: 'blob' });
        triggerDownload(URL.createObjectURL(blob), 'r2tags.zip');
    } catch (err) {
        console.error('Bulk download failed:', err);
        alert(`Download failed: ${err.message}`);
    } finally {
        btn.disabled = getSelectedTagFiles().length === 0;
        btn.textContent = prevText;
        updateDownloadButton();
    }
}

function triggerDownload(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    if (url.startsWith('blob:')) URL.revokeObjectURL(url);
}

// ---- Your submissions (track pending PRs) ---------------------------------

function loadPending() {
    try {
        return JSON.parse(localStorage.getItem(PENDING_KEY)) || [];
    } catch {
        return [];
    }
}

function savePending(records) {
    try {
        localStorage.setItem(PENDING_KEY, JSON.stringify(records));
    } catch { /* storage full/blocked — non-fatal */ }
}

function recordSubmission({ number, url, names }) {
    const records = loadPending();
    if (records.some(r => r.number === number)) return; // de-dupe
    records.push({ number, url, names, submittedAt: Date.now(), status: 'pending' });
    savePending(records);
    renderPending();
}

function dismissSubmission(number) {
    savePending(loadPending().filter(r => r.number !== number));
    renderPending();
}

function statusMeta(status) {
    switch (status) {
        case 'published': return { label: 'Published ✓', cls: 'badge-published' };
        case 'closed': return { label: 'Closed', cls: 'badge-closed' };
        default: return { label: 'In review', cls: 'badge-pending' };
    }
}

function renderPending() {
    const records = loadPending().sort((a, b) => b.submittedAt - a.submittedAt);
    if (!records.length) {
        pendingPanel.hidden = true;
        pendingList.innerHTML = '';
        return;
    }
    pendingPanel.hidden = false;
    pendingList.innerHTML = '';

    for (const r of records) {
        const { label, cls } = statusMeta(r.status);
        const li = document.createElement('li');
        li.className = 'submission-item';

        const left = document.createElement('div');
        const prLink = r.url
            ? `<a href="${r.url}" target="_blank" rel="noopener">PR #${r.number}</a> · `
            : '';
        left.innerHTML =
            `<div class="submission-names">${r.names.map(escapeHtml).join(', ')}</div>` +
            `<div class="submission-meta"><span class="badge ${cls}">${label}</span> · ` +
            `${prLink}${relativeTime(r.submittedAt)}</div>`;

        const dismiss = document.createElement('button');
        dismiss.className = 'remove-file';
        dismiss.textContent = '✕';
        dismiss.title = 'Dismiss';
        dismiss.addEventListener('click', () => dismissSubmission(r.number));

        li.appendChild(left);
        li.appendChild(dismiss);
        pendingList.appendChild(li);
    }
}

// Poll the public PR state for any still-pending submissions and update status.
async function refreshPendingStatuses() {
    const records = loadPending();
    const pending = records.filter(r => r.status === 'pending');
    if (!pending.length) return;

    let changed = false;
    let anyPublished = false;

    await Promise.all(pending.map(async (r) => {
        try {
            const res = await fetch(`https://api.github.com/repos/${REPO}/pulls/${r.number}`, {
                headers: { Accept: 'application/vnd.github+json' },
            });
            if (!res.ok) return; // rate-limited or transient — leave as pending
            const pr = await res.json();
            if (pr.state === 'closed') {
                const next = pr.merged_at ? 'published' : 'closed';
                r.status = next;
                changed = true;
                if (next === 'published') anyPublished = true;
            }
        } catch { /* network blip — leave as pending */ }
    }));

    if (changed) {
        savePending(records);
        renderPending();
    }
    if (anyPublished) loadManifest(); // newly-merged tag now in the browse list
}

function relativeTime(ts) {
    const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- start.gg account linking (upload) ------------------------------------

const STARTGG_BASE = UPLOAD_ENDPOINT ? `${UPLOAD_ENDPOINT}/startgg` : null;

// Pull a `user/xxxx` slug out of a pasted profile URL or raw slug.
function parseUserSlug(text) {
    const s = (text || '').trim();
    const m = s.match(/user\/([a-z0-9]+)/i);
    return m ? `user/${m[1]}` : null;
}

// A self-contained start.gg account picker (search-as-you-type with avatars,
// or paste a profile URL). One is created per submitted tag, so each tag links
// its own account. `onChange` fires with the selected { slug, tag } or null.
// Returns { root, get, set }.
function createStartggPicker(onChange) {
    const root = document.createElement('div');
    root.className = 'sgg-picker';
    let selected = null;
    let timer = null;
    let seq = 0;

    function render() {
        if (selected) {
            const label = selected.tag ? `@${escapeHtml(selected.tag)}` : escapeHtml(selected.slug);
            root.innerHTML =
                `<span class="sgg-chip">Linked: ` +
                `<a href="https://www.start.gg/${encodeURI(selected.slug)}" target="_blank" rel="noopener">${label}</a>` +
                `<button type="button" class="sgg-clear" title="Remove">✕</button></span>`;
            root.querySelector('.sgg-clear').addEventListener('click', () => set(null));
            return;
        }
        root.innerHTML =
            '<div class="sgg-search-wrap">' +
            '<input type="text" class="sgg-input" autocomplete="off" spellcheck="false" ' +
            'placeholder="Link a start.gg account — search or paste profile URL…">' +
            '<ul class="sgg-results" hidden></ul></div>';
        const input = root.querySelector('.sgg-input');
        const results = root.querySelector('.sgg-results');
        input.addEventListener('input', () => {
            const q = input.value.trim();
            clearTimeout(timer);
            if (q.length < 2) { results.hidden = true; results.innerHTML = ''; return; }
            timer = setTimeout(() => search(q, results), 250);
        });
    }

    function set(v) {
        selected = v;
        render();
        onChange && onChange(selected);
    }

    function renderResults(results, players) {
        if (!players.length) {
            results.innerHTML = '<li class="sgg-result-empty muted">No start.gg accounts found.</li>';
            results.hidden = false;
            return;
        }
        results.innerHTML = '';
        players.forEach(p => {
            const li = document.createElement('li');
            li.className = 'sgg-result';
            const tag = (p.prefix ? `${p.prefix} | ` : '') + (p.gamerTag || '(no tag)');
            const avatar = p.image
                ? `<img class="sgg-avatar" src="${escapeHtml(p.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
                : `<span class="sgg-avatar sgg-avatar-empty">${escapeHtml((p.gamerTag || '?').slice(0, 1).toUpperCase())}</span>`;
            li.innerHTML = avatar +
                '<span class="sgg-result-text">' +
                `<span class="sgg-result-tag">${escapeHtml(tag)}</span>` +
                `<span class="sgg-result-slug">${escapeHtml(p.slug)}</span></span>`;
            li.addEventListener('click', () => set({ slug: p.slug, tag: p.gamerTag || '' }));
            results.appendChild(li);
        });
        results.hidden = false;
    }

    async function search(query, results) {
        if (!STARTGG_BASE) return;
        const mySeq = ++seq;
        let players = [];
        try {
            const slug = parseUserSlug(query);
            if (slug) {
                const res = await fetch(`${STARTGG_BASE}/user?slug=${encodeURIComponent(slug)}`);
                const data = await res.json();
                if (mySeq !== seq) return;
                players = res.ok ? [{ slug: data.slug, gamerTag: data.gamerTag, prefix: data.prefix, image: data.image }] : [];
            } else {
                const res = await fetch(`${STARTGG_BASE}/search?q=${encodeURIComponent(query)}`);
                const data = await res.json();
                if (mySeq !== seq) return;
                players = res.ok ? (data.players || []) : [];
            }
        } catch {
            if (mySeq !== seq) return;
            players = [];
        }
        renderResults(results, players);
    }

    render();
    return { root, get: () => selected, set };
}

// Close any open results dropdown when clicking outside it.
document.addEventListener('click', (e) => {
    document.querySelectorAll('.sgg-picker .sgg-results').forEach(results => {
        const wrap = results.closest('.sgg-search-wrap');
        if (!wrap || !wrap.contains(e.target)) {
            results.hidden = true;
        }
    });
});

// ---- Download by start.gg bracket -----------------------------------------

// Pull `tournament/<t>/event/<e>` out of a start.gg event URL.
function parseEventSlug(text) {
    const s = (text || '').trim();
    const m = s.match(/tournament\/([^/\s?#]+)\/event\/([^/\s?#]+)/i);
    return m ? `tournament/${m[1]}/event/${m[2]}` : null;
}

function setBracketStatus(message, kind = '') {
    bracketStatus.textContent = message;
    bracketStatus.className = `bracket-status${kind ? ' ' + kind : ''}`;
}

async function findBracketTags() {
    if (!STARTGG_BASE) {
        setBracketStatus('Bracket lookup isn’t connected yet.', 'error');
        return;
    }
    const slug = parseEventSlug(bracketInput.value);
    if (!slug) {
        setBracketStatus('That doesn’t look like a start.gg event URL.', 'error');
        return;
    }

    bracketGo.disabled = true;
    setBracketStatus('Looking up entrants…');
    try {
        const res = await fetch(`${STARTGG_BASE}/event?slug=${encodeURIComponent(slug)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `${res.status}`);

        const slugs = new Set((data.entrants || []).map(e => e.slug));
        const matches = allTags.filter(t => t.startgg && slugs.has(t.startgg.slug));

        // Select the matching tags in the browser and clear the rest.
        const matchFiles = new Set(matches.map(t => t.file));
        tagBrowser.querySelectorAll('.tag-checkbox').forEach(cb => {
            cb.checked = matchFiles.has(cb.value);
        });
        updateDownloadButton();

        const evName = data.event ? ` for “${data.event}”` : '';
        if (!matches.length) {
            setBracketStatus(
                `No published tags match the ${slugs.size} linked entrant(s)${evName}.`, 'warn');
        } else {
            setBracketStatus(
                `Selected ${matches.length} tag(s)${evName} — scroll down and click Download.`, 'success');
            tagBrowser.querySelector('#downloadSelected')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    } catch (err) {
        setBracketStatus(`Lookup failed: ${err.message}`, 'error');
    } finally {
        bracketGo.disabled = false;
    }
}

if (bracketGo) {
    bracketGo.addEventListener('click', findBracketTags);
    bracketInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); findBracketTags(); }
    });
}

// ---- Load a .sav: pick tags to share or download (in-browser) -------------

async function zipR2tag(name, r2tagBytes) {
    const zip = new JSZip();
    zip.file(`${name}.r2tag`, r2tagBytes);
    const blob = await zip.generateAsync({ type: 'blob' });
    return new File([blob], `${name}.r2tag.zip`, { type: 'application/zip' });
}

async function loadSavFile(file) {
    try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const tags = await getTagNames(bytes);
        loadedSav = { bytes, tags, name: file.name };
        renderSavPanel();
    } catch (err) {
        loadedSav = null;
        savPanel.hidden = false;
        savPanel.innerHTML =
            `<p class="upload-status error">Couldn't read that save: ${escapeHtml(String(err.message || err))}</p>`;
    }
}

function getCheckedSavTags() {
    return [...savPanel.querySelectorAll('.sav-tag-checkbox:checked')].map(cb => cb.value);
}

function renderSavPanel() {
    if (!loadedSav) { savPanel.hidden = true; savPanel.innerHTML = ''; return; }
    savPanel.hidden = false;

    if (!loadedSav.tags.length) {
        savPanel.innerHTML = `<p class="muted">No custom tags found in ${escapeHtml(loadedSav.name)}.</p>`;
        return;
    }

    const items = loadedSav.tags.map(name =>
        '<li class="tag-list-item"><label class="tag-list-label">' +
        `<input type="checkbox" class="sav-tag-checkbox tag-checkbox" value="${escapeHtml(name)}">` +
        `<span class="tag-list-name">${escapeHtml(name)}</span></label></li>`
    ).join('');

    savPanel.innerHTML =
        `<div class="sav-tags-head">${loadedSav.tags.length} custom tag(s) in ` +
        `<code>${escapeHtml(loadedSav.name)}</code></div>` +
        `<ul class="tag-list">${items}</ul>` +
        '<div class="upload-actions">' +
        '<button type="button" id="savAddBtn" disabled>Add to submission ↑</button>' +
        '<button type="button" id="savDownloadBtn" class="secondary" disabled>Download .r2tag</button>' +
        '</div>';

    const sync = () => {
        const n = getCheckedSavTags().length;
        savPanel.querySelector('#savAddBtn').disabled = n === 0;
        savPanel.querySelector('#savDownloadBtn').disabled = n === 0;
    };
    savPanel.querySelectorAll('.sav-tag-checkbox').forEach(cb => cb.addEventListener('change', sync));
    savPanel.querySelector('#savAddBtn').addEventListener('click', addSavTagsToSubmission);
    savPanel.querySelector('#savDownloadBtn').addEventListener('click', downloadSavTags);
}

// Export the checked tags from the loaded save, zip each, and feed them into the
// submission list above (so the normal start.gg + submit flow takes over).
async function addSavTagsToSubmission() {
    const names = getCheckedSavTags();
    if (!names.length || !loadedSav) return;
    const btn = savPanel.querySelector('#savAddBtn');
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = 'Preparing…';
    try {
        for (const name of names) {
            const r2 = await exportTag(loadedSav.bytes, name);
            addFiles([await zipR2tag(name, r2)]);
        }
        setStatus(
            `Added ${names.length} tag(s) from your save below. Link your start.gg account, then Submit.`,
            'success'
        );
        savPanel.querySelectorAll('.sav-tag-checkbox:checked').forEach(cb => { cb.checked = false; });
        btn.disabled = true;
        savPanel.querySelector('#savDownloadBtn').disabled = true;
    } catch (err) {
        setStatus(`Couldn't prepare tags: ${err.message || err}`, 'error');
        btn.disabled = false;
    } finally {
        btn.textContent = prev;
    }
}

async function downloadSavTags() {
    const names = getCheckedSavTags();
    if (!names.length || !loadedSav) return;
    const btn = savPanel.querySelector('#savDownloadBtn');
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = 'Exporting…';
    try {
        if (names.length === 1) {
            const r2 = await exportTag(loadedSav.bytes, names[0]);
            triggerDownload(URL.createObjectURL(new Blob([r2])), `${names[0]}.r2tag`);
        } else {
            const zip = new JSZip();
            for (const name of names) {
                zip.file(`${name}.r2tag`, await exportTag(loadedSav.bytes, name));
            }
            const blob = await zip.generateAsync({ type: 'blob' });
            triggerDownload(URL.createObjectURL(blob), 'r2tags.zip');
        }
    } catch (err) {
        alert(`Export failed: ${err.message || err}`);
    } finally {
        btn.disabled = false;
        btn.textContent = prev;
    }
}

// ---- Import shared tags into your .sav (in-browser) -----------------------

let pendingImportFiles = [];

function setImportStatus(message, kind = '') {
    importStatus.innerHTML = message;
    importStatus.className = `upload-status${kind ? ' ' + kind : ''}`;
}

function startImportToSave() {
    pendingImportFiles = getSelectedTagFiles();
    if (!pendingImportFiles.length) return;
    importSavInput.value = '';
    importSavInput.click();
}

async function fetchR2tagBytes(file) {
    const res = await fetch(`data/${file}`);
    if (!res.ok) throw new Error(`Could not fetch ${file}`);
    const zip = await JSZip.loadAsync(await res.blob());
    const entry = Object.values(zip.files).find(
        f => !f.dir && f.name.toLowerCase().endsWith('.r2tag')
    );
    if (!entry) throw new Error(`${file} has no .r2tag inside`);
    return entry.async('uint8array');
}

async function importSelectedToSave(savFile) {
    const files = pendingImportFiles;
    if (!files.length) return;
    setImportStatus('Reading your save and the selected tags…');
    try {
        const savBytes = new Uint8Array(await savFile.arrayBuffer());
        const overwrite = !!(importOverwrite && importOverwrite.checked);
        const items = [];
        for (const file of files) {
            items.push({ bytes: await fetchR2tagBytes(file), overwrite });
        }
        const rep = await importTags(savBytes, items);
        triggerDownload(URL.createObjectURL(new Blob([rep.sav])), savFile.name);

        const parts = [];
        if (rep.imported.length) parts.push(`${rep.imported.length} imported`);
        if (rep.skipped.length) parts.push(`${rep.skipped.length} skipped (already exist)`);
        if (rep.incompatible.length) parts.push(`${rep.incompatible.length} incompatible (different game version)`);
        setImportStatus(
            `Done — ${parts.join(', ') || 'no changes'}. Downloaded your updated ` +
            `<strong>${escapeHtml(savFile.name)}</strong>; replace your save file with it ` +
            `(make a backup first).`,
            rep.incompatible.length ? 'warn' : 'success'
        );
    } catch (err) {
        setImportStatus(`Import failed: ${err.message || err}`, 'error');
    }
}

// ---- Wire up events -------------------------------------------------------

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fileInput.click();
    }
});

fileInput.addEventListener('change', () => {
    addFiles(Array.from(fileInput.files));
    fileInput.value = ''; // allow re-selecting the same file
});

['dragenter', 'dragover'].forEach(evt =>
    dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
    })
);

['dragleave', 'drop'].forEach(evt =>
    dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
    })
);

dropzone.addEventListener('drop', (e) => {
    if (e.dataTransfer?.files?.length) {
        addFiles(Array.from(e.dataTransfer.files));
    }
});

submitButton.addEventListener('click', submitTags);
clearButton.addEventListener('click', () => {
    selectedFiles = [];
    renderFileList();
});

// Load-a-save (submit panel) and import-into-save (browse panel) file inputs.
if (savButton) {
    savButton.addEventListener('click', () => savInput.click());
    savInput.addEventListener('change', () => {
        if (savInput.files?.length) loadSavFile(savInput.files[0]);
        savInput.value = '';
    });
}
if (importSavInput) {
    importSavInput.addEventListener('change', () => {
        if (importSavInput.files?.length) importSelectedToSave(importSavInput.files[0]);
        importSavInput.value = '';
    });
}

// Init
renderFileList();
loadManifest();
renderPending();
refreshPendingStatuses();
// While anything is still in review, re-check its PR periodically.
setInterval(() => {
    if (loadPending().some(r => r.status === 'pending')) refreshPendingStatuses();
}, POLL_INTERVAL_MS);
