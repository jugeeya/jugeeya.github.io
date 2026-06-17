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

        const prLink = data.pr
            ? ` <a href="${data.pr}" target="_blank" rel="noopener">PR #${data.number}</a>`
            : '';
        setStatus(
            `Submitted ${valid.length} tag(s).${prLink} It’ll appear below once it passes review.`,
            'success'
        );
        selectedFiles = [];
        renderFileList();
        // Manifest won't update until the PR merges; refresh anyway in case it's quick.
        setTimeout(loadManifest, 1500);
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
