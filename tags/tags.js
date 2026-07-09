// Tag-sharing page.
//
// The page is organized as two guided flows, both shown at once (the overview
// cards up top just jump to the matching section):
//   - Share your tag        (players): load .sav → select tags + link start.gg → submit
//   - Install tags to setup (TOs):     pick tags (bracket URL or by hand) → merge
//     into a setup's .sav → put the downloaded save back
//
// Browsing reads a static manifest (data/index.json) served by GitHub Pages.
//
// Submitting sends the selected .r2tag.zip file(s) to a broker (a small
// Cloudflare Worker) which opens a pull request on the repo via a GitHub App.
// A GitHub Action then validates the PR and auto-merges it if it's benign, at
// which point the tag appears in the browse list.
//
// Set UPLOAD_ENDPOINT to your deployed Worker URL to turn submitting on. While
// it's null the page is browse-only and Submit explains it isn't wired up.
// See broker/README.md for how to stand up the Worker + GitHub App.

import { getTagNames, exportTag, importTags, tagJson } from './wasm/tagsav.js';
import { diffTagRoot, renderDiff } from './tagdiff.js';

const UPLOAD_ENDPOINT = 'https://r2tag-broker.jdsambasivam.workers.dev';
const MANIFEST_URL = 'data/index.json';
const REPO = 'jugeeya/jugeeya.github.io';      // for polling public PR status
const PENDING_KEY = 'r2tag_pending_submissions'; // localStorage key
const POLL_INTERVAL_MS = 45000;

// State
// Each share entry is one selected tag from the loaded save:
// { name, file (zipped .r2tag), picker } — picker.get() is the tag's start.gg
// link ({ slug, tag } | null); every submitted tag carries its own.
let shareEntries = [];
let allTags = [];
let tagSearchQuery = '';

// DOM — flows (both are always visible; the overview cards are plain anchor
// links to #shareFlow / #getFlow, so no JS is needed for those)
const shareStep1 = document.getElementById('shareStep1');
const shareStep2 = document.getElementById('shareStep2');
const shareStep3 = document.getElementById('shareStep3');
const getStep2 = document.getElementById('getStep2');
const getStep3 = document.getElementById('getStep3');

// DOM — share flow
const savButton = document.getElementById('savButton');
const savInput = document.getElementById('savInput');
const savLoadStatus = document.getElementById('savLoadStatus');
const shareLoadedNote = document.getElementById('shareLoadedNote');
const shareTagList = document.getElementById('shareTagList');
const shareDownloadBtn = document.getElementById('shareDownloadBtn');
const authorInput = document.getElementById('authorInput');
const submitButton = document.getElementById('submitButton');
const clearButton = document.getElementById('clearButton');
const uploadStatus = document.getElementById('uploadStatus');

// DOM — submissions + get flow
const pendingPanel = document.getElementById('pendingPanel');
const pendingList = document.getElementById('pendingList');
const tagBrowser = document.getElementById('tagBrowser');
const bracketInput = document.getElementById('bracketInput');
const bracketGo = document.getElementById('bracketGo');
const bracketStatus = document.getElementById('bracketStatus');
const importSelectedBtn = document.getElementById('importSelected');
const downloadSelectedBtn = document.getElementById('downloadSelected');
const importSavInput = document.getElementById('importSavInput');
const importOverwrite = document.getElementById('importOverwrite');
const importStatus = document.getElementById('importStatus');

// A loaded .sav: its raw bytes + the custom tag names found in it.
let loadedSav = null;

// ---- Step states ------------------------------------------------------------

// A step is 'locked' (dimmed, body hidden), 'active' (usable) or 'done'
// (usable, with a check in place of its number).
function setStepState(stepEl, state) {
    if (!stepEl) return;
    stepEl.classList.toggle('is-locked', state === 'locked');
    stepEl.classList.toggle('is-active', state === 'active');
    stepEl.classList.toggle('is-done', state === 'done');
}

// ---- Helpers ----------------------------------------------------------------

function setStatus(message, kind = '') {
    uploadStatus.innerHTML = message;
    uploadStatus.className = `upload-status${kind ? ' ' + kind : ''}`;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function triggerDownload(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    if (url.startsWith('blob:')) URL.revokeObjectURL(url);
}

// ---- Share flow: load a .sav ------------------------------------------------

async function zipR2tag(name, r2tagBytes) {
    const zip = new JSZip();
    zip.file(`${name}.r2tag`, r2tagBytes);
    const blob = await zip.generateAsync({ type: 'blob' });
    return new File([blob], `${name}.r2tag.zip`, { type: 'application/zip' });
}

async function loadSavFile(file) {
    savLoadStatus.textContent = '';
    savLoadStatus.className = 'upload-status';
    try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const tags = await getTagNames(bytes);
        loadedSav = { bytes, tags, name: file.name };
        resetShareSelection();
        renderShareTagList();

        setStepState(shareStep1, 'done');
        savButton.textContent = 'Load a different save file';
        shareLoadedNote.hidden = false;
        shareLoadedNote.innerHTML =
            `Loaded <code>${escapeHtml(file.name)}</code>. ` +
            (tags.length
                ? `Found <strong>${tags.length}</strong> custom tag(s).`
                : 'No custom tags found in it.');
        setStepState(shareStep2, 'active');
    } catch (err) {
        loadedSav = null;
        resetShareSelection();
        renderShareTagList();
        setStepState(shareStep1, 'active');
        shareLoadedNote.hidden = true;
        savLoadStatus.textContent = `Couldn't read that save: ${err.message || err}`;
        savLoadStatus.className = 'upload-status error';
        setStepState(shareStep2, 'locked');
    }
}

function resetShareSelection() {
    shareEntries = [];
    updateSubmitState();
}

function renderShareTagList() {
    shareTagList.innerHTML = '';
    if (!loadedSav || !loadedSav.tags.length) {
        if (loadedSav) {
            shareTagList.innerHTML =
                `<li class="tag-list-empty muted">No custom tags found in ${escapeHtml(loadedSav.name)}. ` +
                'Create a tag in-game first, then reload the save.</li>';
        }
        return;
    }

    for (const name of loadedSav.tags) {
        const li = document.createElement('li');
        li.className = 'share-tag-item';

        const label = document.createElement('label');
        label.className = 'tag-list-label';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'tag-checkbox share-tag-checkbox';
        checkbox.value = name;

        const nameEl = document.createElement('span');
        nameEl.className = 'tag-list-name';
        nameEl.textContent = name;

        label.appendChild(checkbox);
        label.appendChild(nameEl);

        const sggSlot = document.createElement('div');
        sggSlot.className = 'share-tag-sgg';
        sggSlot.hidden = true;

        checkbox.addEventListener('change', () => toggleShareTag(name, checkbox, li, sggSlot));

        li.appendChild(label);
        li.appendChild(sggSlot);
        shareTagList.appendChild(li);
    }
}

// Selecting a tag exports it from the save (in-browser via WASM), zips it and
// reveals its own start.gg picker right on the row. Deselecting removes it.
async function toggleShareTag(name, checkbox, row, sggSlot) {
    if (checkbox.checked) {
        checkbox.disabled = true;
        row.classList.add('is-busy');
        try {
            const r2 = await exportTag(loadedSav.bytes, name);
            const file = await zipR2tag(name, r2);
            const picker = createStartggPicker(updateSubmitState);
            shareEntries.push({ name, file, picker });
            sggSlot.innerHTML = '';
            sggSlot.appendChild(picker.root);
            sggSlot.hidden = false;
            row.classList.add('is-selected');
        } catch (err) {
            checkbox.checked = false;
            setStatus(`Couldn't read “${escapeHtml(name)}” from the save: ${escapeHtml(String(err.message || err))}`, 'error');
        } finally {
            checkbox.disabled = false;
            row.classList.remove('is-busy');
        }
    } else {
        shareEntries = shareEntries.filter(e => e.name !== name);
        sggSlot.hidden = true;
        sggSlot.innerHTML = '';
        row.classList.remove('is-selected');
    }
    updateSubmitState();
}

function updateSubmitState() {
    const n = shareEntries.length;
    const allLinked = n > 0 && shareEntries.every(e => e.picker.get());
    submitButton.disabled = !allLinked;
    clearButton.disabled = n === 0;
    if (shareDownloadBtn) shareDownloadBtn.disabled = n === 0;

    setStepState(shareStep3, n > 0 ? 'active' : 'locked');

    if (n > 0 && !allLinked) {
        setStatus('Link a start.gg account to each selected tag, then submit.', 'warn');
    } else if (uploadStatus.classList.contains('warn')) {
        setStatus('');
    }
}

function clearShareSelection() {
    shareEntries = [];
    shareTagList.querySelectorAll('.share-tag-checkbox').forEach(cb => { cb.checked = false; });
    shareTagList.querySelectorAll('.share-tag-sgg').forEach(slot => {
        slot.hidden = true;
        slot.innerHTML = '';
    });
    shareTagList.querySelectorAll('.share-tag-item').forEach(li => li.classList.remove('is-selected'));
    updateSubmitState();
    setStatus('');
}

// "Just want the files?" — export the selected tags as raw .r2tag downloads
// (single file, or one zip of them all), without submitting anything.
async function downloadShareTags() {
    const names = shareEntries.map(e => e.name);
    if (!names.length || !loadedSav) return;
    shareDownloadBtn.disabled = true;
    const prev = shareDownloadBtn.textContent;
    shareDownloadBtn.textContent = 'Exporting…';
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
        setStatus(`Export failed: ${escapeHtml(String(err.message || err))}`, 'error');
    } finally {
        shareDownloadBtn.disabled = shareEntries.length === 0;
        shareDownloadBtn.textContent = prev;
    }
}

// ---- Share flow: submit -----------------------------------------------------

async function submitTags() {
    if (!shareEntries.length) return;
    if (!shareEntries.every(e => e.picker.get())) {
        setStatus('Link a start.gg account to each selected tag before submitting.', 'error');
        return;
    }

    if (!UPLOAD_ENDPOINT) {
        setStatus(
            'Submitting isn’t connected yet. This page is a scaffold. ' +
            'Set UPLOAD_ENDPOINT in tags.js to your broker Worker to enable it.',
            'error'
        );
        return;
    }

    setStatus('Submitting…');
    submitButton.disabled = true;
    try {
        const form = new FormData();
        shareEntries.forEach(e => {
            const link = e.picker.get();
            form.append('tags', e.file, e.file.name);
            form.append('startgg_slug', link.slug);
            form.append('startgg_tag', link.tag || '');
        });
        form.append('author', (authorInput?.value || '').trim());

        const res = await fetch(UPLOAD_ENDPOINT, { method: 'POST', body: form });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);

        const count = shareEntries.length;
        const names = shareEntries.map(e => e.name);
        if (data.number) {
            recordSubmission({ number: data.number, url: data.pr, names });
        }

        const prLink = data.pr
            ? ` <a href="${data.pr}" target="_blank" rel="noopener">PR #${data.number}</a>`
            : '';
        clearShareSelection();
        setStatus(
            `Submitted ${count} tag(s).${prLink} Tracking it under “Your submissions” below.`,
            'success'
        );
        // Poll the PR so the status updates from “In review” to “Published”.
        refreshPendingStatuses();
    } catch (err) {
        console.error('Submission failed:', err);
        setStatus(`Submission failed: ${err.message}`, 'error');
    } finally {
        updateSubmitState();
    }
}

// ---- Get flow: browse shared tags ------------------------------------------

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
    return allTags.filter(tag => {
        const sg = tag.startgg || {};
        // Match the tag name, the author, and the linked start.gg gamer tag /
        // slug (so you can find tags by start.gg account too).
        const haystack = [
            tagDisplayName(tag),
            tag.author || '',
            sg.tag || '',
            sg.slug || '',
        ].join(' ').toLowerCase();
        return haystack.includes(query);
    });
}

function getSelectedTagFiles() {
    return [...tagBrowser.querySelectorAll('.tag-checkbox:checked')]
        .map(cb => cb.value);
}

function updateDownloadButton() {
    const count = getSelectedTagFiles().length;
    // Keep the button labels fixed so they don't resize as the count changes;
    // the running count lives in its own chip next to the selection controls.
    downloadSelectedBtn.disabled = count === 0;
    importSelectedBtn.disabled = count === 0;

    // Step 2 opens up as soon as there's something to merge. Step 3 stays put
    // once revealed (the download the user needs to move doesn't un-happen).
    if (!getStep2.classList.contains('is-done')) {
        setStepState(getStep2, count > 0 ? 'active' : 'locked');
    }

    const countEl = tagBrowser.querySelector('#tagSelectedCount');
    if (countEl) {
        // Always present (so nothing shifts as it toggles); dimmed at zero.
        countEl.textContent = `${count} selected`;
        countEl.classList.toggle('is-zero', count === 0);
    }
}

// Builds the browser chrome (search box, selection controls, list container)
// once and wires its listeners. The list itself is (re)drawn by renderTagList —
// so typing in the search box never recreates the input and never drops focus.
function renderTagBrowser() {
    if (!allTags.length) {
        tagBrowser.innerHTML = '<p class="muted">No shared tags yet. Be the first to share one.</p>';
        return;
    }

    tagBrowser.innerHTML =
        '<div class="tag-browser-toolbar">' +
        '<input type="search" id="tagSearch" class="tag-search" ' +
        'placeholder="Search in-game or start.gg tag…" autocomplete="off">' +
        '<div class="tag-browser-actions">' +
        '<button type="button" id="selectAllTags" class="linkish">Select all</button>' +
        '<span class="tag-action-sep">·</span>' +
        '<button type="button" id="clearTagSelection" class="linkish">Clear</button>' +
        '<span id="tagSelectedCount" class="tag-selected-count is-zero">0 selected</span>' +
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

            // "View changes" expander — shows how this tag differs from default,
            // if we have a precomputed digest for it.
            addChangeToggle(li, file);

            list.appendChild(li);
        });
    }

    updateDownloadButton();
}

// Adds a "View changes" link to a tag row, toggling a diff-from-default panel
// inserted just below the row. The tag's .r2tag is fetched and parsed in-browser
// (via the WASM) on first open, then diffed against the default baseline.
function addChangeToggle(li, file) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tag-diff-toggle linkish';
    btn.textContent = 'View changes';

    let panel = null;
    btn.addEventListener('click', async (e) => {
        e.preventDefault();
        if (panel) {
            panel.hidden = !panel.hidden;
            btn.textContent = panel.hidden ? 'View changes' : 'Hide changes';
            return;
        }
        panel = document.createElement('li');
        panel.className = 'tag-diff-panel';
        panel.innerHTML = '<div class="tag-diff-body muted">Loading…</div>';
        li.after(panel);
        btn.textContent = 'Hide changes';
        const body = panel.querySelector('.tag-diff-body');
        try {
            const root = await tagJson(await fetchR2tagBytes(file));
            renderDiff(body, await diffTagRoot(root));
        } catch (err) {
            body.classList.remove('muted');
            body.innerHTML = `<p class="tag-diff-empty muted">Couldn't read this tag (${escapeHtml(String(err.message || err))}).</p>`;
        }
    });

    li.appendChild(btn);
}

async function downloadSelectedTags() {
    const files = getSelectedTagFiles();
    if (!files.length) return;

    const tags = files
        .map(file => allTags.find(t => t.file === file))
        .filter(Boolean);
    if (!tags.length) return;

    const btn = downloadSelectedBtn;
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

// ---- start.gg account linking (share flow) ----------------------------------

const STARTGG_BASE = UPLOAD_ENDPOINT ? `${UPLOAD_ENDPOINT}/startgg` : null;

// Pull a `user/xxxx` slug out of a pasted profile URL or raw slug.
function parseUserSlug(text) {
    const s = (text || '').trim();
    const m = s.match(/user\/([a-z0-9]+)/i);
    return m ? `user/${m[1]}` : null;
}

// A self-contained start.gg account picker (search-as-you-type with avatars,
// or paste a profile URL). One is created per selected tag, so each tag links
// its own account. `onChange` fires with the selected { slug, tag } or null.
// Returns { root, get, set }.
function createStartggPicker(onChange) {
    const root = document.createElement('div');
    root.className = 'sgg-picker';
    let selected = null;
    let timer = null;
    let seq = 0;

    // Search/pagination state (start.gg returns ~30 per page; we load more as
    // the dropdown is scrolled, de-duping by slug).
    let curQuery = '';
    let page = 1;
    let totalPages = 1;
    let loadingMore = false;
    const seen = new Set();

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
            'placeholder="Link a start.gg account: search or paste profile URL…">' +
            '<ul class="sgg-results" hidden></ul></div>';
        const input = root.querySelector('.sgg-input');
        const results = root.querySelector('.sgg-results');
        input.addEventListener('input', () => {
            const q = input.value.trim();
            clearTimeout(timer);
            if (q.length < 2) { results.hidden = true; results.innerHTML = ''; return; }
            timer = setTimeout(() => startSearch(q, results), 250);
        });
        results.addEventListener('scroll', () => {
            if (results.scrollTop + results.clientHeight >= results.scrollHeight - 48) {
                maybeLoadMore(results);
            }
        });
    }

    function set(v) {
        selected = v;
        render();
        onChange && onChange(selected);
    }

    function makeRow(p) {
        const li = document.createElement('li');
        li.className = 'sgg-result';
        const tag = (p.prefix ? `${p.prefix} | ` : '') + (p.gamerTag || '(no tag)');
        const initial = (p.gamerTag || '?').slice(0, 1).toUpperCase();

        const letterAvatar = () => {
            const span = document.createElement('span');
            span.className = 'sgg-avatar sgg-avatar-empty';
            span.textContent = initial;
            return span;
        };

        let avatar;
        if (p.image) {
            avatar = document.createElement('img');
            avatar.className = 'sgg-avatar';
            avatar.alt = '';
            avatar.referrerPolicy = 'no-referrer';
            // If the image fails (expired/blocked/missing), fall back to the
            // initial instead of a broken-image icon.
            avatar.addEventListener('error', () => avatar.replaceWith(letterAvatar()));
            avatar.src = p.image;
        } else {
            avatar = letterAvatar();
        }

        const text = document.createElement('span');
        text.className = 'sgg-result-text';
        text.innerHTML =
            `<span class="sgg-result-tag">${escapeHtml(tag)}</span>` +
            `<span class="sgg-result-slug">${escapeHtml(p.slug)}</span>`;

        li.appendChild(avatar);
        li.appendChild(text);
        li.addEventListener('click', () => set({ slug: p.slug, tag: p.gamerTag || '' }));
        return li;
    }

    function setLoadingMore(results, on) {
        const existing = results.querySelector('.sgg-loading');
        if (on && !existing) {
            const li = document.createElement('li');
            li.className = 'sgg-loading muted';
            li.textContent = 'Loading more…';
            results.appendChild(li);
        } else if (!on && existing) {
            existing.remove();
        }
    }

    function appendPlayers(results, players, append) {
        if (!append) { results.innerHTML = ''; seen.clear(); }
        const fresh = players.filter(p => p.slug && !seen.has(p.slug));
        fresh.forEach(p => seen.add(p.slug));
        if (!append && fresh.length === 0) {
            results.innerHTML = '<li class="sgg-result-empty muted">No start.gg accounts found.</li>';
            results.hidden = false;
            return;
        }
        fresh.forEach(p => results.appendChild(makeRow(p)));
        results.hidden = false;
    }

    function startSearch(q, results) {
        curQuery = q;
        page = 1;
        totalPages = 1;
        seq++;
        fetchPage(results, false);
    }

    function maybeLoadMore(results) {
        if (loadingMore || page >= totalPages || parseUserSlug(curQuery)) return;
        page += 1;
        fetchPage(results, true);
    }

    async function fetchPage(results, append) {
        if (!STARTGG_BASE) return;
        const mySeq = seq;
        loadingMore = true;
        if (append) setLoadingMore(results, true);
        let players = [];
        let tp = totalPages;
        try {
            const slug = parseUserSlug(curQuery);
            if (slug) {
                const res = await fetch(`${STARTGG_BASE}/user?slug=${encodeURIComponent(slug)}`);
                const data = await res.json();
                if (mySeq !== seq) return;
                players = res.ok ? [{ slug: data.slug, gamerTag: data.gamerTag, prefix: data.prefix, image: data.image }] : [];
                tp = 1;
            } else {
                const res = await fetch(`${STARTGG_BASE}/search?q=${encodeURIComponent(curQuery)}&page=${page}`);
                const data = await res.json();
                if (mySeq !== seq) return;
                players = res.ok ? (data.players || []) : [];
                tp = (res.ok && data.totalPages) || page;
            }
        } catch {
            if (mySeq !== seq) return;
            players = [];
        } finally {
            if (mySeq === seq) { loadingMore = false; setLoadingMore(results, false); }
        }
        if (mySeq !== seq) return;
        totalPages = tp;
        appendPlayers(results, players, append);
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

// ---- Get flow: select by start.gg bracket -----------------------------------

// Pull the event slug out of a start.gg URL, plus the phase-group id when the
// URL points at a single bracket section (…/brackets/<phaseId>/<phaseGroupId>).
// Returns { slug, phaseGroupId } or null.
function parseEventTarget(text) {
    const s = (text || '').trim();
    const m = s.match(/tournament\/([^/\s?#]+)\/event\/([^/\s?#]+)/i);
    if (!m) return null;
    const b = s.match(/\/brackets\/\d+\/(\d+)/i);
    return { slug: `tournament/${m[1]}/event/${m[2]}`, phaseGroupId: b ? b[1] : null };
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
    const target = parseEventTarget(bracketInput.value);
    if (!target) {
        setBracketStatus('That doesn’t look like a start.gg event URL.', 'error');
        return;
    }

    bracketGo.disabled = true;
    setBracketStatus(target.phaseGroupId ? 'Looking up this bracket section…' : 'Looking up entrants…');
    try {
        const params = new URLSearchParams({ slug: target.slug });
        if (target.phaseGroupId) params.set('phaseGroupId', target.phaseGroupId);
        const res = await fetch(`${STARTGG_BASE}/event?${params}`);
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

        const scope = data.section ? `${data.event || 'event'} — ${data.section}` : data.event;
        const evName = scope ? ` for “${scope}”` : '';
        if (!matches.length) {
            setBracketStatus(
                `No published tags match the ${slugs.size} linked entrant(s)${evName}.`, 'warn');
        } else {
            setBracketStatus(
                `Selected ${matches.length} tag(s)${evName}. Continue with step 2 below.`, 'success');
            getStep2.scrollIntoView({ behavior: 'smooth', block: 'center' });
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

// ---- Get flow: merge shared tags into a .sav (in-browser) --------------------

let pendingImportFiles = [];

function setImportStatus(message, kind = '') {
    importStatus.innerHTML = message;
    importStatus.className = `upload-status${kind ? ' ' + kind : ''}`;
}

function startImportToSave() {
    pendingImportFiles = getSelectedTagFiles();
    if (!pendingImportFiles.length) return;

    // Open the guided modal (copy path → choose file). The actual read goes
    // through a classic <input type=file>: the File System Access API can't be
    // used here because the Rivals save lives under %LOCALAPPDATA%, a folder
    // Chromium hard-blocks ("this folder contains system files"). The merged
    // result is delivered as a download the user drops back into the folder.
    openSaveModal('import');
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

// Merge the currently selected shared tags into the given save bytes.
async function mergeSelectedTags(savBytes) {
    const overwrite = !!(importOverwrite && importOverwrite.checked);
    const items = [];
    for (const file of pendingImportFiles) {
        items.push({ bytes: await fetchR2tagBytes(file), overwrite });
    }
    return importTags(savBytes, items);
}

function importSummary(rep) {
    const parts = [];
    if (rep.imported.length) parts.push(`${rep.imported.length} imported`);
    if (rep.skipped.length) parts.push(`${rep.skipped.length} skipped (already exist)`);
    if (rep.incompatible.length) parts.push(`${rep.incompatible.length} incompatible (different game version)`);
    return parts.join(', ') || 'no changes';
}

// Deliver the finished save bytes as a download. We can't write straight back to
// the save folder: it sits under %LOCALAPPDATA%, which the File System Access
// "Save As" picker blocks just like the open picker, so there's no reliable
// in-browser "save in place" for this tool.
function saveOutput(bytes, filename) {
    triggerDownload(URL.createObjectURL(new Blob([bytes])), filename);
}

// Reports the merge result and unlocks step 3 (put the downloaded save back).
function deliveredStatus(rep, filename) {
    setImportStatus(
        `Done: ${importSummary(rep)}. Downloaded <strong>${escapeHtml(filename)}</strong>. ` +
        `Step 3 below shows where to put it.`,
        rep.incompatible.length ? 'warn' : 'success'
    );
    setStepState(getStep2, 'done');
    setStepState(getStep3, 'active');
    getStep3.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// Read the picked .sav, merge the selected tags in, and download the result.
async function importSelectedToSave(savFile) {
    if (!pendingImportFiles.length) return;
    setImportStatus('Reading your save and the selected tags…');
    try {
        const savBytes = new Uint8Array(await savFile.arrayBuffer());
        const rep = await mergeSelectedTags(savBytes);
        saveOutput(rep.sav, savFile.name);
        deliveredStatus(rep, savFile.name);
    } catch (err) {
        setImportStatus(`Import failed: ${err.message || err}`, 'error');
    }
}

// ---- Wire up events -------------------------------------------------------

// Save-path platform switcher (Windows / Steam Deck). The Steam Deck location
// is the fixed Proton prefix under the user's home folder. Two flavours per OS:
// the full file path (load a save — paste into the Open dialog) and the folder
// (put the merged save back — paste into Explorer, then drop the download in).
// The switcher is shared: any .save-path-hint on the page (there are two)
// updates together, keyed by its data-path-kind ("file" or "folder").
const SAVE_PATHS = {
    windows: {
        file: {
            path: '%LOCALAPPDATA%\\Rivals2\\Saved\\SaveGames\\Rivals2_PlayerTagSaveSlot.sav',
            intro: 'On Windows your save is here (under <code>C:\\Users\\&lt;you&gt;\\AppData\\Local</code>):',
            tip: 'Tip: paste this into the file picker\'s <em>File name</em> box and hit Open to jump straight to it.',
        },
        folder: {
            path: '%LOCALAPPDATA%\\Rivals2\\Saved\\SaveGames',
            intro: 'On Windows the save folder is here (under <code>C:\\Users\\&lt;you&gt;\\AppData\\Local</code>):',
            tip: 'Tip: paste this into Explorer\'s address bar, then replace <code>Rivals2_PlayerTagSaveSlot.sav</code> with the file you just downloaded.',
        },
    },
    deck: {
        file: {
            path: '~/.local/share/Steam/steamapps/compatdata/217000/pfx/drive_c/users/steamuser/AppData/Local/Rivals2/Saved/SaveGames/Rivals2_PlayerTagSaveSlot.sav',
            intro: 'On Steam Deck (Proton) your save is under your home folder:',
            tip: 'Tip: in the file picker press <kbd>Ctrl</kbd>+<kbd>L</kbd> and paste this path. You may need to show hidden files (<kbd>Ctrl</kbd>+<kbd>H</kbd>).',
        },
        folder: {
            path: '~/.local/share/Steam/steamapps/compatdata/217000/pfx/drive_c/users/steamuser/AppData/Local/Rivals2/Saved/SaveGames',
            intro: 'On Steam Deck (Proton) the save folder is under your home folder:',
            tip: 'Tip: open this folder (file manager ▸ <kbd>Ctrl</kbd>+<kbd>L</kbd>, paste) and replace the old <code>.sav</code> with the one you just downloaded. You may need to show hidden files (<kbd>Ctrl</kbd>+<kbd>H</kbd>).',
        },
    },
};

function setSavePathOs(os) {
    if (!SAVE_PATHS[os]) return;
    document.querySelectorAll('.save-path-hint').forEach(hint => {
        const kind = hint.dataset.pathKind === 'folder' ? 'folder' : 'file';
        const data = SAVE_PATHS[os][kind];
        const textEl = hint.querySelector('.save-path-text');
        const introEl = hint.querySelector('.save-path-intro');
        const tipEl = hint.querySelector('.save-path-tip');
        if (textEl) textEl.textContent = data.path;
        if (introEl) introEl.innerHTML = data.intro;
        if (tipEl) tipEl.innerHTML = data.tip;
        hint.querySelectorAll('.path-os-btn').forEach(btn =>
            btn.classList.toggle('is-active', btn.dataset.os === os));
        // The copied path is now stale — clear any "Copied" note.
        clearCopyFeedback(hint);
    });
}

// The "Copied ✓" note sits beside the copy button and stays until the path
// changes (kept visible so the confirmation doesn't flash away, per feedback).
function clearCopyFeedback(scope) {
    (scope || document).querySelectorAll('.copy-feedback').forEach(fb => {
        fb.hidden = true;
        fb.textContent = '';
        fb.classList.remove('is-error');
    });
}

document.querySelectorAll('.path-os-btn').forEach(btn => {
    btn.addEventListener('click', () => setSavePathOs(btn.dataset.os));
});

document.querySelectorAll('.copy-path-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
        const hint = btn.closest('.save-path-hint');
        const path = hint?.querySelector('.save-path-text')?.textContent.trim() || '';
        const fb = hint?.querySelector('.copy-feedback');
        // Keep the button label put; show a persistent note beside it instead.
        try {
            await navigator.clipboard.writeText(path);
            if (fb) { fb.textContent = 'Copied ✓'; fb.classList.remove('is-error'); fb.hidden = false; }
        } catch {
            if (fb) { fb.textContent = 'Copy failed'; fb.classList.add('is-error'); fb.hidden = false; }
        }
    });
});

submitButton.addEventListener('click', submitTags);
clearButton.addEventListener('click', clearShareSelection);
if (shareDownloadBtn) shareDownloadBtn.addEventListener('click', downloadShareTags);

// Guided save-file modal. Both "Load my save file" and "Merge into a save file"
// open it: it shows the save path to copy, then a Choose-file button that opens
// the real (classic) file picker for the matching input.
const saveModal = document.getElementById('saveModal');
const saveModalTitle = document.getElementById('saveModalTitle');
const saveModalChoose = document.getElementById('saveModalChoose');
const saveModalClose = document.getElementById('saveModalClose');
let saveModalMode = 'load'; // 'load' | 'import'

function openSaveModal(mode) {
    saveModalMode = mode;
    saveModalTitle.textContent = mode === 'import' ? 'Merge into your save' : 'Load your save file';
    saveModalChoose.textContent = mode === 'import' ? 'Choose save file…' : 'Choose file…';
    clearCopyFeedback(saveModal);   // fresh "Copied" state each open
    saveModal.hidden = false;
    document.body.classList.add('modal-open');
    // Focus the copy button (step 1) so keyboard users land inside the dialog.
    saveModal.querySelector('.copy-path-btn')?.focus();
}

function closeSaveModal() {
    saveModal.hidden = true;
    document.body.classList.remove('modal-open');
}

if (saveModal) {
    saveModalChoose.addEventListener('click', () => {
        const input = saveModalMode === 'import' ? importSavInput : savInput;
        input.value = '';
        input.click();          // the native picker takes over from here
        closeSaveModal();
    });
    saveModalClose.addEventListener('click', closeSaveModal);
    // Click the backdrop (outside the dialog) to dismiss.
    saveModal.addEventListener('click', (e) => { if (e.target === saveModal) closeSaveModal(); });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !saveModal.hidden) closeSaveModal();
    });
}

// Load-a-save (share flow) and merge-into-save (get flow) file inputs.
if (savButton) {
    savButton.addEventListener('click', () => openSaveModal('load'));
    savInput.addEventListener('change', () => {
        if (savInput.files?.length) loadSavFile(savInput.files[0]);
        savInput.value = '';
    });
}
importSelectedBtn.addEventListener('click', startImportToSave);
downloadSelectedBtn.addEventListener('click', downloadSelectedTags);
if (importSavInput) {
    importSavInput.addEventListener('change', () => {
        if (importSavInput.files?.length) importSelectedToSave(importSavInput.files[0]);
        importSavInput.value = '';
    });
}

// ---- Hero screenshot lightbox ---------------------------------------------

const lightbox = document.getElementById('lightbox');
if (lightbox) {
    const lightboxImg = document.getElementById('lightboxImg');
    const lightboxClose = document.getElementById('lightboxClose');

    const openLightbox = (src, alt) => {
        lightboxImg.src = src;
        lightboxImg.alt = alt || '';
        lightbox.hidden = false;
        document.body.classList.add('modal-open');
        lightboxClose.focus();
    };
    const closeLightbox = () => {
        lightbox.hidden = true;
        lightboxImg.src = '';
        document.body.classList.remove('modal-open');
    };

    document.querySelectorAll('.shot').forEach(btn => {
        btn.addEventListener('click', () => {
            const img = btn.querySelector('img');
            openLightbox(btn.dataset.full || img?.src, img?.alt);
        });
    });
    lightboxClose.addEventListener('click', closeLightbox);
    // Click the backdrop (anywhere that isn't the image) to dismiss.
    lightbox.addEventListener('click', (e) => { if (e.target !== lightboxImg) closeLightbox(); });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !lightbox.hidden) closeLightbox();
    });
}

// Init
loadManifest();
renderPending();
refreshPendingStatuses();
updateSubmitState();
// While anything is still in review, re-check its PR periodically.
setInterval(() => {
    if (loadPending().some(r => r.status === 'pending')) refreshPendingStatuses();
}, POLL_INTERVAL_MS);
