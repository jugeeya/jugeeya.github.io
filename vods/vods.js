// start.gg VOD Splitter — runs entirely in the browser.
//
// - Previews: a hidden <video> is seeked to each clip's start/end and the frame
//   is drawn to a canvas (instant, native — no ffmpeg needed for previews).
// - Cutting (Option A): ffmpeg.wasm mounts the local file via WORKERFS (lazy
//   reads, so multi-GB VODs don't have to fit in memory) and stream-copies each
//   clip (`-ss … -i … -t … -c copy`), writing outputs to a folder you pick.
// - Command generator (Option B): emits an ffmpeg script you run with your own
//   native ffmpeg.

const BROKER = 'https://r2tag-broker.jdsambasivam.workers.dev';

// ffmpeg.wasm from CDN (UMD globals; single-threaded core needs no COOP/COEP).
const FF = {
  ffmpeg: 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js',
  util: 'https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/umd/index.js',
  core: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd',
};

const $ = (id) => document.getElementById(id);

// ---- State ----------------------------------------------------------------
let vodFile = null;        // the chosen File (read lazily from disk)
let vodUrl = null;         // object URL for the preview <video>
let vodDuration = 0;       // seconds
let sets = [];             // [{ startedAt, completedAt, station, name }]
let clips = [];            // [{ id, name, start, end }]
let nextId = 1;

const scrubber = $('scrubber');
const grabber = $('grabber');

// ---- Time helpers ---------------------------------------------------------
function clock(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  return `${h}:${p(m)}:${p(s)}`;
}
function parseClock(str) {
  const parts = String(str).trim().split(':').map(Number);
  if (parts.some(isNaN)) return null;
  let s = 0;
  for (const p of parts) s = s * 60 + p;
  return s;
}
function ffTime(sec) {
  // ffmpeg accepts plain seconds; keep 3 decimals for accuracy.
  return (Math.max(0, sec)).toFixed(3);
}

// OBS default filename: "2024-01-15 14-30-00" (also allows underscores).
function parseObsDate(name) {
  const m = name.match(/(\d{4})-(\d{2})-(\d{2})[ _T](\d{2})[-:](\d{2})[-:](\d{2})/);
  if (!m) return null;
  const [, Y, Mo, D, h, mi, s] = m.map(Number);
  return new Date(Y, Mo - 1, D, h, mi, s);
}
function toLocalInput(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function recStartEpoch() {
  const v = $('recStart').value;
  if (!v) return null;
  const t = new Date(v).getTime();
  return isNaN(t) ? null : t / 1000;
}

// ---- Load the VOD ---------------------------------------------------------
function loadVod(file) {
  vodFile = file;
  if (vodUrl) URL.revokeObjectURL(vodUrl);
  vodUrl = URL.createObjectURL(file);
  scrubber.src = vodUrl;
  $('vodInfo').textContent = `${file.name} · ${(file.size / 1e9).toFixed(2)} GB`;
  $('vodInfo').classList.remove('muted');

  scrubber.onloadedmetadata = () => {
    vodDuration = scrubber.duration || 0;
    $('vodInfo').textContent += ` · ${clock(vodDuration)}`;
    renderClips();
    updateActionButtons();
  };

  const d = parseObsDate(file.name);
  const hint = $('recStartHint');
  if (d) {
    $('recStart').value = toLocalInput(d);
    hint.textContent = `Auto-detected from the filename.`;
  } else if (!$('recStart').value) {
    hint.textContent = `Couldn't read a time from the filename — set it manually.`;
  }
}

$('vodButton').addEventListener('click', async () => {
  if (window.showOpenFilePicker) {
    try {
      const [h] = await showOpenFilePicker({
        types: [{ description: 'Video', accept: { 'video/*': ['.mp4', '.mkv', '.mov', '.flv', '.ts'] } }],
      });
      loadVod(await h.getFile());
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
  }
  $('vodInput').click();
});
$('vodInput').addEventListener('change', () => {
  if ($('vodInput').files?.length) loadVod($('vodInput').files[0]);
});
$('recStart').addEventListener('change', () => renderClips());

// ---- Frame previews (seek the hidden <video>, draw to canvas) -------------
let grabQueue = Promise.resolve();
function grabFrame(sec) {
  // Serialize seeks — one <video> element, one seek at a time.
  grabQueue = grabQueue.then(() => new Promise((resolve) => {
    if (!vodUrl || !isFinite(sec)) return resolve(null);
    const t = Math.max(0, Math.min(sec, Math.max(0, vodDuration - 0.05)));
    const onSeeked = () => {
      scrubber.removeEventListener('seeked', onSeeked);
      try {
        const w = 240, h = Math.round(w * (scrubber.videoHeight / scrubber.videoWidth || 0.5625));
        grabber.width = w; grabber.height = h;
        grabber.getContext('2d').drawImage(scrubber, 0, 0, w, h);
        resolve(grabber.toDataURL('image/jpeg', 0.7));
      } catch { resolve(null); }
    };
    scrubber.addEventListener('seeked', onSeeked);
    try { scrubber.currentTime = t; } catch { resolve(null); }
  }));
  return grabQueue;
}

// ---- start.gg -------------------------------------------------------------
function parseEventSlug(input) {
  const s = (input || '').trim();
  const m = s.match(/tournament\/[^/\s]+\/event\/[^/\s?#]+/i);
  return m ? m[0] : s.replace(/^\/+|\/+$/g, '');
}

$('fetchSets').addEventListener('click', async () => {
  const slug = parseEventSlug($('eventInput').value);
  const status = $('setsStatus');
  if (!/^tournament\/[^/]+\/event\/[^/]+$/i.test(slug)) {
    status.textContent = 'Enter an event URL like start.gg/tournament/…/event/…';
    status.className = 'sets-status error';
    return;
  }
  status.textContent = 'Fetching sets…';
  status.className = 'sets-status';
  $('fetchSets').disabled = true;
  try {
    const res = await fetch(`${BROKER}/startgg/sets?slug=${encodeURIComponent(slug)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    sets = (data.sets || []).filter((s) => s.startedAt && s.completedAt);
    if (!sets.length) { status.textContent = 'No completed sets with timestamps found.'; return; }
    const stations = [...new Set(sets.map((s) => s.station).filter((n) => n != null))].sort((a, b) => a - b);
    const sel = $('stationSelect');
    sel.innerHTML = '';
    if (stations.length) {
      for (const n of stations) sel.appendChild(new Option(`Station ${n} (${sets.filter((s) => s.station === n).length} sets)`, n));
    }
    sel.appendChild(new Option(`All stations (${sets.length} sets)`, ''));
    $('stationField').hidden = false;
    status.textContent = `${data.event || 'Event'}: ${sets.length} completed set(s).`;
    status.className = 'sets-status success';
  } catch (e) {
    status.textContent = `Couldn't fetch sets: ${e.message}`;
    status.className = 'sets-status error';
  } finally {
    $('fetchSets').disabled = false;
  }
});

$('buildClips').addEventListener('click', () => {
  const rec = recStartEpoch();
  if (rec == null) { setSplitStatus('Set the recording start time first.', 'error'); return; }
  const station = $('stationSelect').value;
  const pre = Number($('padPre').value) || 0;
  const post = Number($('padPost').value) || 0;
  const chosen = sets
    .filter((s) => station === '' || String(s.station) === String(station))
    .sort((a, b) => a.startedAt - b.startedAt);

  const built = [];
  for (const s of chosen) {
    const start = s.startedAt - rec - pre;
    const end = s.completedAt - rec + post;
    // Keep only clips that land inside the recording.
    if (end <= 0 || (vodDuration && start >= vodDuration)) continue;
    built.push({
      id: nextId++,
      name: s.name || `Set ${s.id}`,
      start: Math.max(0, start),
      end: vodDuration ? Math.min(end, vodDuration) : end,
    });
  }
  if (!built.length) {
    setSplitStatus('No sets fall inside this recording — check the start time / station.', 'error');
    return;
  }
  clips = built;
  renderClips();
  updateActionButtons();
  setSplitStatus(`Built ${clips.length} clip(s). Review the frames below, then split.`, 'success');
});

// ---- Clip list ------------------------------------------------------------
function sanitizeName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'clip';
}
function outName(clip, i) {
  const ext = (vodFile?.name.match(/\.[a-z0-9]+$/i) || ['.mp4'])[0];
  return `${String(i + 1).padStart(2, '0')} - ${sanitizeName(clip.name)}${ext}`;
}

function renderClips() {
  const list = $('clipList');
  if (!clips.length) {
    list.innerHTML = '<p class="muted">No clips yet — build them from start.gg above, or add one by hand.</p>';
    return;
  }
  list.innerHTML = '';
  clips.forEach((clip, i) => {
    const row = document.createElement('div');
    row.className = 'clip-row';
    row.innerHTML = `
      <label class="clip-include"><input type="checkbox" data-k="on" checked></label>
      <input class="clip-name" data-k="name" value="${escapeAttr(clip.name)}">
      <div class="clip-times">
        <label>start <input class="clip-time" data-k="start" value="${clock(clip.start)}"></label>
        <label>end <input class="clip-time" data-k="end" value="${clock(clip.end)}"></label>
        <span class="clip-dur">${clock(Math.max(0, clip.end - clip.start))}</span>
      </div>
      <div class="clip-frames">
        <figure><img data-frame="start" alt="start frame"><figcaption>start</figcaption></figure>
        <figure><img data-frame="end" alt="end frame"><figcaption>end</figcaption></figure>
      </div>`;
    row.querySelector('[data-k="name"]').addEventListener('input', (e) => { clip.name = e.target.value; });
    for (const k of ['start', 'end']) {
      row.querySelector(`[data-k="${k}"]`).addEventListener('change', (e) => {
        const v = parseClock(e.target.value);
        if (v != null) { clip[k] = v; e.target.value = clock(v); refreshFrames(row, clip); updateDur(row, clip); }
      });
    }
    row.dataset.id = clip.id;
    list.appendChild(row);
    refreshFrames(row, clip);
  });
}
function updateDur(row, clip) {
  row.querySelector('.clip-dur').textContent = clock(Math.max(0, clip.end - clip.start));
}
async function refreshFrames(row, clip) {
  if (!vodUrl) return;
  const [a, b] = [row.querySelector('[data-frame="start"]'), row.querySelector('[data-frame="end"]')];
  a.classList.add('loading'); b.classList.add('loading');
  const s = await grabFrame(clip.start); if (s) { a.src = s; a.classList.remove('loading'); }
  const e = await grabFrame(Math.max(clip.start, clip.end - 0.1)); if (e) { b.src = e; b.classList.remove('loading'); }
}
function includedRows() {
  return [...$('clipList').querySelectorAll('.clip-row')].filter((r) => r.querySelector('[data-k="on"]').checked);
}
function includedClips() {
  return includedRows().map((r) => clips.find((c) => c.id === Number(r.dataset.id))).filter(Boolean);
}

$('addClip').addEventListener('click', () => {
  clips.push({ id: nextId++, name: 'Clip', start: 0, end: Math.min(60, vodDuration || 60) });
  renderClips(); updateActionButtons();
});
$('clearClips').addEventListener('click', () => { clips = []; renderClips(); updateActionButtons(); });

function updateActionButtons() {
  const ready = clips.length > 0 && vodFile;
  $('splitBtn').disabled = !ready;
  $('scriptBtn').disabled = !clips.length;
}

// ---- Option B: ffmpeg command generator -----------------------------------
function buildScript(kind) {
  const inp = vodFile ? vodFile.name : 'INPUT.mkv';
  const q = (s) => `"${s.replace(/"/g, '\\"')}"`;
  const lines = includedClips().length ? includedClips() : clips;
  const cmds = lines.map((c, i) =>
    `ffmpeg -y -ss ${ffTime(c.start)} -i ${q(inp)} -t ${ffTime(Math.max(0, c.end - c.start))} -c copy ${q(outName(c, i))}`
  );
  if (kind === 'bat') return ['@echo off', ...cmds, 'echo Done.'].join('\r\n') + '\r\n';
  return ['#!/bin/sh', 'set -e', ...cmds, 'echo Done.'].join('\n') + '\n';
}

$('scriptBtn').addEventListener('click', () => {
  const isWin = navigator.platform.toLowerCase().includes('win');
  const kind = isWin ? 'bat' : 'sh';
  const text = buildScript(kind);
  navigator.clipboard?.writeText(text).catch(() => {});
  const blob = new Blob([text], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `split-clips.${kind}`;
  a.click();
  setSplitStatus(`Copied ${includedClips().length || clips.length} ffmpeg command(s) to your clipboard and downloaded split-clips.${kind}. Run it in the folder with your VOD.`, 'success');
});

// ---- Option A: split in the browser with ffmpeg.wasm ----------------------
let ffmpeg = null;
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}
async function getFfmpeg() {
  if (ffmpeg) return ffmpeg;
  setSplitStatus('Loading ffmpeg (~30 MB, first time only)…');
  if (!window.FFmpegWASM) await loadScript(FF.ffmpeg);
  if (!window.FFmpegUtil) await loadScript(FF.util);
  const { FFmpeg } = window.FFmpegWASM;
  const { toBlobURL } = window.FFmpegUtil;
  const ff = new FFmpeg();
  ff.on('progress', ({ progress }) => { if (progress >= 0 && progress <= 1) window.__clipProgress = progress; });
  await ff.load({
    coreURL: await toBlobURL(`${FF.core}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${FF.core}/ffmpeg-core.wasm`, 'application/wasm'),
  });
  ffmpeg = ff;
  return ff;
}

$('splitBtn').addEventListener('click', async () => {
  const chosen = includedClips();
  if (!chosen.length) { setSplitStatus('No clips selected.', 'error'); return; }

  // Pick an output folder (Chromium). Fall back to downloading each clip.
  let dir = null;
  if (window.showDirectoryPicker) {
    try { dir = await showDirectoryPicker({ mode: 'readwrite' }); }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }

  const btn = $('splitBtn'); btn.disabled = true;
  const prog = $('splitProgress'); prog.hidden = false; prog.value = 0;
  try {
    const ff = await getFfmpeg();
    const mnt = '/vod';
    await ff.createDir(mnt).catch(() => {});
    await ff.mount('WORKERFS', { files: [vodFile] }, mnt);
    const input = `${mnt}/${vodFile.name}`;

    for (let i = 0; i < chosen.length; i++) {
      const c = chosen[i];
      const out = outName(c, i);
      setSplitStatus(`Cutting ${i + 1}/${chosen.length}: ${out}`);
      window.__clipProgress = 0;
      await ff.exec(['-y', '-ss', ffTime(c.start), '-i', input, '-t', ffTime(Math.max(0.1, c.end - c.start)), '-c', 'copy', '-avoid_negative_ts', 'make_zero', out]);
      const data = await ff.readFile(out);
      await saveClip(dir, out, data);
      await ff.deleteFile(out).catch(() => {});
      prog.value = (i + 1) / chosen.length;
    }
    await ff.unmount(mnt).catch(() => {});
    setSplitStatus(dir
      ? `Done — ${chosen.length} clip(s) written to the folder you chose.`
      : `Done — ${chosen.length} clip(s) downloaded.`, 'success');
  } catch (e) {
    setSplitStatus(`Split failed: ${e.message || e}`, 'error');
  } finally {
    btn.disabled = false;
    prog.hidden = true;
  }
});

async function saveClip(dir, name, data) {
  if (dir) {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(data);
    await w.close();
  } else {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }));
    a.download = name;
    a.click();
  }
}

// ---- misc -----------------------------------------------------------------
function setSplitStatus(msg, kind = '') {
  const el = $('splitStatus');
  el.textContent = msg;
  el.className = `upload-status${kind ? ' ' + kind : ''}`;
}
function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
