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

const UPLOAD_ENDPOINT = 'https://r2tag-broker.jdsambasivam.workers.dev';
const MANIFEST_URL = 'data/index.json';
const ACCEPTED_EXTENSION = '.zip'; // a zipped .r2tag; contents validated server-side
const MAX_FILE_BYTES = 512 * 1024; // a zipped tag is ~20 KB; this is generous
const REPO = 'jugeeya/jugeeya.github.io';      // for polling public PR status
const PENDING_KEY = 'r2tag_pending_submissions'; // localStorage key
const POLL_INTERVAL_MS = 45000;

// State
let selectedFiles = [];
let allTags = [];
let tagSearchQuery = '';
let selectedStartgg = null; // { slug, tag } once a start.gg account is chosen

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
const sggSearch = document.getElementById('sggSearch');
const sggResults = document.getElementById('sggResults');
const sggSelected = document.getElementById('sggSelected');
const bracketInput = document.getElementById('bracketInput');
const bracketGo = document.getElementById('bracketGo');
const bracketStatus = document.getElementById('bracketStatus');

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
        const dup = selectedFiles.some(f => f.name === file.name && f.size === file.size);
        if (!dup) selectedFiles.push(file);
    }
    renderFileList();
}

function removeFile(index) {
    selectedFiles.splice(index, 1);
    renderFileList();
}

function renderFileList() {
    fileListEl.innerHTML = '';

    selectedFiles.forEach((file, index) => {
        const { ok, message } = validateFile(file);

        const li = document.createElement('li');

        const left = document.createElement('div');
        left.innerHTML =
            `<div>${file.name}</div>` +
            `<div class="file-meta">${formatBytes(file.size)} · ` +
            `<span class="file-status ${ok ? 'ok' : 'warn'}">${message}</span></div>`;

        const remove = document.createElement('button');
        remove.className = 'remove-file';
        remove.textContent = '✕';
        remove.title = 'Remove';
        remove.addEventListener('click', () => removeFile(index));

        li.appendChild(left);
        li.appendChild(remove);
        fileListEl.appendChild(li);
    });

    updateSubmitState();
    clearButton.disabled = selectedFiles.length === 0;
    if (selectedFiles.length === 0) setStatus('');
}

function updateSubmitState() {
    const hasValid = selectedFiles.some(f => validateFile(f).ok);
    submitButton.disabled = !hasValid || !selectedStartgg;
    if (hasValid && !selectedStartgg && !uploadStatus.textContent) {
        setStatus('Link your start.gg account below to submit.', 'warn');
    } else if (uploadStatus.classList.contains('warn')) {
        setStatus('');
    }
}

// ---- Submit ---------------------------------------------------------------

async function submitTags() {
    const valid = selectedFiles.filter(f => validateFile(f).ok);
    if (valid.length === 0) return;
    if (!selectedStartgg) {
        setStatus('Link your start.gg account before submitting.', 'error');
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
        valid.forEach(f => form.append('tags', f, f.name));
        form.append('author', (authorInput?.value || '').trim());
        form.append('startgg_slug', selectedStartgg.slug);
        form.append('startgg_tag', selectedStartgg.tag || '');

        const res = await fetch(UPLOAD_ENDPOINT, { method: 'POST', body: form });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);

        const names = valid.map(f => f.name.replace(/(\.r2tag)?\.zip$/i, ''));
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
}

function renderTagBrowser() {
    if (!allTags.length) {
        tagBrowser.innerHTML = '<p class="muted">No shared tags yet — be the first to upload one.</p>';
        return;
    }

    const previouslySelected = new Set(getSelectedTagFiles());
    const visible = filteredTags();

    tagBrowser.innerHTML =
        '<div class="tag-browser-toolbar">' +
        '<input type="search" id="tagSearch" class="tag-search" ' +
        'placeholder="Search tags…" autocomplete="off">' +
        '<div class="tag-browser-actions">' +
        '<button type="button" id="selectAllTags" class="linkish">Select all</button>' +
        '<span class="tag-action-sep">·</span>' +
        '<button type="button" id="clearTagSelection" class="linkish">Clear</button>' +
        '<button type="button" id="downloadSelected" disabled>Download tags</button>' +
        '</div></div>' +
        '<ul id="tagList" class="tag-list"></ul>';

    const searchInput = tagBrowser.querySelector('#tagSearch');
    searchInput.value = tagSearchQuery;
    searchInput.addEventListener('input', () => {
        tagSearchQuery = searchInput.value;
        renderTagBrowser();
    });

    const list = tagBrowser.querySelector('#tagList');

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

    tagBrowser.querySelector('#selectAllTags').addEventListener('click', () => {
        tagBrowser.querySelectorAll('.tag-checkbox').forEach(cb => { cb.checked = true; });
        updateDownloadButton();
    });

    tagBrowser.querySelector('#clearTagSelection').addEventListener('click', () => {
        tagBrowser.querySelectorAll('.tag-checkbox').forEach(cb => { cb.checked = false; });
        updateDownloadButton();
    });

    tagBrowser.querySelector('#downloadSelected').addEventListener('click', downloadSelectedTags);
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
let sggSearchTimer = null;
let sggSearchSeq = 0; // guard against out-of-order responses

// Pull a `user/xxxx` slug out of a pasted profile URL or raw slug.
function parseUserSlug(text) {
    const s = (text || '').trim();
    const m = s.match(/user\/([a-z0-9]+)/i);
    return m ? `user/${m[1]}` : null;
}

function renderStartggSelected() {
    if (!selectedStartgg) {
        sggSelected.hidden = true;
        sggSelected.innerHTML = '';
        return;
    }
    sggSelected.hidden = false;
    const label = selectedStartgg.tag ? `@${escapeHtml(selectedStartgg.tag)}` : escapeHtml(selectedStartgg.slug);
    sggSelected.innerHTML =
        `<span class="sgg-chip">Linked: ` +
        `<a href="https://www.start.gg/${encodeURI(selectedStartgg.slug)}" target="_blank" rel="noopener">${label}</a>` +
        `<button type="button" class="sgg-clear" title="Remove">✕</button></span>`;
    sggSelected.querySelector('.sgg-clear').addEventListener('click', () => {
        selectedStartgg = null;
        renderStartggSelected();
        sggSearch.value = '';
        updateSubmitState();
    });
}

function chooseStartgg(player) {
    selectedStartgg = { slug: player.slug, tag: player.gamerTag || player.tag || '' };
    hideSggResults();
    sggSearch.value = '';
    renderStartggSelected();
    updateSubmitState();
}

function hideSggResults() {
    sggResults.hidden = true;
    sggResults.innerHTML = '';
}

function renderSggResults(players) {
    if (!players.length) {
        sggResults.innerHTML = '<li class="sgg-result-empty muted">No start.gg accounts found.</li>';
        sggResults.hidden = false;
        return;
    }
    sggResults.innerHTML = '';
    players.forEach(p => {
        const li = document.createElement('li');
        li.className = 'sgg-result';
        const tag = (p.prefix ? `${p.prefix} | ` : '') + (p.gamerTag || '(no tag)');
        const avatar = p.image
            ? `<img class="sgg-avatar" src="${escapeHtml(p.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
            : `<span class="sgg-avatar sgg-avatar-empty">${escapeHtml((p.gamerTag || '?').slice(0, 1).toUpperCase())}</span>`;
        li.innerHTML = avatar +
            `<span class="sgg-result-text">` +
            `<span class="sgg-result-tag">${escapeHtml(tag)}</span>` +
            `<span class="sgg-result-slug">${escapeHtml(p.slug)}</span>` +
            `</span>`;
        li.addEventListener('click', () => chooseStartgg(p));
        sggResults.appendChild(li);
    });
    sggResults.hidden = false;
}

async function runSggSearch(query) {
    if (!STARTGG_BASE) return;
    const seq = ++sggSearchSeq;

    // A pasted profile URL / slug resolves directly to one account.
    const slug = parseUserSlug(query);
    try {
        if (slug) {
            const res = await fetch(`${STARTGG_BASE}/user?slug=${encodeURIComponent(slug)}`);
            const data = await res.json();
            if (seq !== sggSearchSeq) return;
            if (!res.ok) { renderSggResults([]); return; }
            renderSggResults([{ slug: data.slug, gamerTag: data.gamerTag, prefix: data.prefix }]);
            return;
        }
        const res = await fetch(`${STARTGG_BASE}/search?q=${encodeURIComponent(query)}`);
        const data = await res.json();
        if (seq !== sggSearchSeq) return;
        renderSggResults(res.ok ? (data.players || []) : []);
    } catch {
        if (seq === sggSearchSeq) renderSggResults([]);
    }
}

if (sggSearch) {
    sggSearch.addEventListener('input', () => {
        const q = sggSearch.value.trim();
        clearTimeout(sggSearchTimer);
        if (q.length < 2) { hideSggResults(); return; }
        sggSearchTimer = setTimeout(() => runSggSearch(q), 250);
    });
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.sgg-search-wrap')) hideSggResults();
    });
}

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

// Init
renderFileList();
loadManifest();
renderPending();
refreshPendingStatuses();
// While anything is still in review, re-check its PR periodically.
setInterval(() => {
    if (loadPending().some(r => r.status === 'pending')) refreshPendingStatuses();
}, POLL_INTERVAL_MS);
