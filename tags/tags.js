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

    const hasValid = selectedFiles.some(f => validateFile(f).ok);
    submitButton.disabled = !hasValid;
    clearButton.disabled = selectedFiles.length === 0;
    if (selectedFiles.length === 0) setStatus('');
}

// ---- Submit ---------------------------------------------------------------

async function submitTags() {
    const valid = selectedFiles.filter(f => validateFile(f).ok);
    if (valid.length === 0) return;

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
        renderTagBrowser(Array.isArray(manifest.tags) ? manifest.tags : []);
    } catch (err) {
        console.error('Could not load tag manifest:', err);
        tagBrowser.innerHTML = '<p class="muted">No shared tags yet.</p>';
    }
}

function renderTagBrowser(tags) {
    if (!tags.length) {
        tagBrowser.innerHTML = '<p class="muted">No shared tags yet — be the first to upload one.</p>';
        return;
    }

    tagBrowser.innerHTML = '';
    tags.forEach(tag => {
        const card = document.createElement('div');
        card.className = 'tag-card';

        const name = document.createElement('div');
        name.className = 'tag-name';
        name.textContent = tag.name || tag.file || 'Untitled tag';

        const author = document.createElement('div');
        author.className = 'tag-author';
        author.textContent = tag.author ? `by ${tag.author}` : 'unknown author';

        const link = document.createElement('a');
        link.className = 'download';
        link.href = tag.file ? `data/${tag.file}` : '#';
        link.textContent = '⬇ Download .r2tag.zip';
        link.setAttribute('download', '');

        card.appendChild(name);
        card.appendChild(author);
        card.appendChild(link);
        tagBrowser.appendChild(card);
    });
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
