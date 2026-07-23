// MatchLogger operator console — reads the broker's aggregated per-event view
// (GET /matchlogger/event?slug=…) and shows live "now playing" per station
// plus a sets-today table across every station. Reporting a matched set to
// start.gg is gated behind the operator passcode (see the Report button
// below); it's a no-op until the broker also has start.gg write access
// configured.

const DEFAULT_BROKER = 'https://r2tag-broker.jdsambasivam.workers.dev';
const POLL_MS = 5000;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let timer = null;
let demoMode = false;
let pickerOpen = false; // pause re-render while the operator is choosing a winner
const setsById = {}; // "station:id" -> record, for the report picker

// ---- config persistence ---------------------------------------------------
const LS_SLUG = 'ml.slug';
const LS_BROKER = 'ml.broker';

function brokerUrl() {
  return ($('brokerInput').value.trim() || DEFAULT_BROKER).replace(/\/+$/, '');
}

function parseEventSlug(input) {
  const s = (input || '').trim();
  const m = s.match(/tournament\/[^/\s]+\/event\/[^/\s?#]+/i);
  return m ? m[0] : s.replace(/^\/+|\/+$/g, '');
}

// ---- time helpers ---------------------------------------------------------
function ago(epochSec) {
  if (!epochSec) return '';
  const d = Math.max(0, Math.floor(Date.now() / 1000 - epochSec));
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  return `${Math.floor(d / 3600)}h ago`;
}
function clock(epochSec) {
  if (!epochSec) return '—';
  const dt = new Date(epochSec * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(dt.getHours())}:${p(dt.getMinutes())}`;
}

// ---- status ---------------------------------------------------------------
function setStatus(msg, kind) {
  const el = $('status');
  el.textContent = msg || '';
  el.className = 'ml-status' + (kind ? ' ' + kind : '');
}

// ---- rendering ------------------------------------------------------------
function playersLabel(players, winnerName) {
  if (!players || !players.length) return '';
  return players.map((p) => {
    const isWin = winnerName && p.name === winnerName;
    const nm = `<span class="${isWin ? 'win' : ''}">${esc(p.name || '?')}</span>`;
    const ch = p.character ? ` <span class="char">(${esc(p.character)})</span>` : '';
    return nm + ch;
  }).join(' vs ');
}

function renderStations(stations) {
  const wrap = $('stations');
  const keys = Object.keys(stations || {}).sort((a, b) => Number(a) - Number(b));
  $('stationsPanel').hidden = keys.length === 0;
  if (!keys.length) { wrap.innerHTML = ''; return; }

  wrap.innerHTML = keys.map((k) => {
    const s = stations[k];
    const cur = s.current || {};
    const sg = s.startgg || null;
    const live = cur.state && cur.state !== 'idle';
    const stateLabel = ({ set_start: 'set start', match_start: 'in game', set_open: 'between games', idle: 'idle' }[cur.state]) || (cur.state || 'idle');
    let players = '<span class="muted">—</span>';
    if (sg && sg.entrants && sg.entrants.length) {
      players = sg.entrants.map((e) => esc(e.name)).join(' <span class="muted">vs</span> ');
    }
    const round = sg && sg.fullRoundText ? `<div class="stn-round">${esc(sg.fullRoundText)}</div>` : '';
    return `
      <div class="station-card">
        <div class="stn-head">
          <span class="stn-name">Station ${esc(k)}</span>
          <span class="pill ${live ? 'live' : 'idle'}">${esc(stateLabel)}</span>
        </div>
        <div class="stn-players">${players}</div>
        ${round}
        <div class="stn-updated">${esc(ago(s.updatedAt))}</div>
      </div>`;
  }).join('');
}

function renderSets(sets) {
  const body = $('setsBody');
  // Don't clobber an open winner-picker mid-interaction (poll runs every 5s).
  if (pickerOpen) return;
  const rows = (sets || []).slice().reverse(); // most recent first for the operator
  $('setsPanel').hidden = false;
  $('setCount').textContent = rows.length ? `${rows.length} set${rows.length === 1 ? '' : 's'}` : '';
  for (const k of Object.keys(setsById)) delete setsById[k];
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="8" class="empty">No sets recorded yet.</td></tr>`;
    return;
  }

  body.innerHTML = rows.map((r) => {
    setsById[`${r.station}:${r.id}`] = r;
    const s = r.set || {};
    const score = (s.players || []).map((p) => p.wins).filter((w) => w != null).join('–');
    const conf = r.confidence || 'none';
    const winnerCell = r.candidateWinnerEntrantId
      ? `<span class="conf ${esc(conf)}" title="match confidence: ${esc(conf)}">${esc(entrantName(r))}</span>`
      : `<span class="conf none">unmatched</span>`;
    const status = r.status || 'recorded';
    const canReport = r.matchedStartggSetId && (r.entrants || []).length && status !== 'reported';
    let action;
    if (status === 'reported') {
      action = `<span class="conf high">✓ reported</span>`;
    } else if (canReport) {
      action = `<button class="secondary report-btn" data-key="${esc(r.station)}:${esc(r.id)}">Report</button>`;
    } else {
      action = `<button class="secondary report-btn" disabled title="${r.matchedStartggSetId ? 'no entrants to pick from' : 'not matched to a start.gg set'}">Report</button>`;
    }
    return `
      <tr>
        <td class="stn-cell">${esc(r.station)}</td>
        <td class="time-cell">${esc(clock(s.endEpoch || r.ingestedAt))}</td>
        <td>${playersLabel(s.players, s.winnerName)}</td>
        <td class="score">${esc(score || '—')}</td>
        <td>${esc(r.fullRoundText || '—')}</td>
        <td>${winnerCell}</td>
        <td><span class="pill ${esc(status)}">${esc(status)}</span></td>
        <td class="action-cell">${action}</td>
      </tr>`;
  }).join('');
}

// ---- reporting ------------------------------------------------------------
// Report is delegated off #setsBody (which is re-rendered on each poll), so the
// handler survives re-renders. Clicking Report opens an inline winner picker
// (also lets the operator correct a wrong/low-confidence auto-match).
function openPicker(cell, rec) {
  if (!$('passcodeInput').value.trim()) {
    setStatus('Enter the operator passcode first (top of the page).', 'error');
    $('passcodeInput').focus();
    return;
  }
  pickerOpen = true;
  cell._rec = rec; // the element persists across the innerHTML swap
  const btns = (rec.entrants || []).map((e) =>
    `<button class="secondary pick-entrant" data-entrant="${esc(e.id)}">${esc(e.name || 'entrant')}</button>`).join(' ');
  cell.innerHTML = `<span class="report-pick">win: ${btns}
    <button class="linkish pick-cancel" title="cancel">✕</button></span>`;
}

async function doReport(rec, winnerEntrantId) {
  pickerOpen = false; // we're committing → let the next render refresh the row
  setStatus('Reporting…');
  try {
    const res = await fetch(`${brokerUrl()}/matchlogger/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: parseEventSlug($('eventInput').value),
        station: rec.station,
        setId: rec.id,
        winnerEntrantId,
        passcode: $('passcodeInput').value,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    setStatus('Reported to start.gg.', 'success');
    refresh();
  } catch (e) {
    setStatus(`Report failed: ${e.message}`, 'error');
    refresh(); // restore the row
  }
}

function onSetsClick(ev) {
  const reportBtn = ev.target.closest('.report-btn');
  if (reportBtn && !reportBtn.disabled) {
    const rec = setsById[reportBtn.dataset.key];
    if (rec) openPicker(reportBtn.closest('.action-cell'), rec);
    return;
  }
  const pick = ev.target.closest('.pick-entrant');
  if (pick) {
    const cell = pick.closest('.action-cell');
    if (cell && cell._rec) doReport(cell._rec, pick.dataset.entrant);
    return;
  }
  if (ev.target.closest('.pick-cancel')) { pickerOpen = false; refresh(); }
}

function entrantName(r) {
  const e = (r.entrants || []).find((x) => x.id === r.candidateWinnerEntrantId);
  return e ? e.name : (r.set && r.set.winnerName) || '?';
}

// ---- data -----------------------------------------------------------------
async function refresh() {
  if (demoMode) return;
  const slug = parseEventSlug($('eventInput').value);
  if (!/^tournament\/[^/]+\/event\/[^/]+$/i.test(slug)) return;
  try {
    const res = await fetch(`${brokerUrl()}/matchlogger/event?slug=${encodeURIComponent(slug)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    renderStations(data.stations || {});
    renderSets(data.sets || []);
    const total = (data.sets || []).length;
    setStatus(`Connected — ${total} set${total === 1 ? '' : 's'} across ${Object.keys(data.stations || {}).length} station(s).`, 'success');
  } catch (e) {
    setStatus(`Couldn't load: ${e.message}`, 'error');
  }
}

function connect() {
  demoMode = false;
  const slug = parseEventSlug($('eventInput').value);
  if (!/^tournament\/[^/]+\/event\/[^/]+$/i.test(slug)) {
    setStatus('Enter an event URL like start.gg/tournament/…/event/…', 'error');
    return;
  }
  localStorage.setItem(LS_SLUG, $('eventInput').value.trim());
  localStorage.setItem(LS_BROKER, $('brokerInput').value.trim());
  $('liveDot').style.display = '';
  setStatus('Connecting…');
  refresh();
  if (timer) clearInterval(timer);
  timer = setInterval(refresh, POLL_MS);
}

// ---- demo -----------------------------------------------------------------
function loadDemo() {
  demoMode = true;
  if (timer) { clearInterval(timer); timer = null; }
  $('liveDot').style.display = 'none';
  const now = Math.floor(Date.now() / 1000);
  renderStations({
    3: { current: { state: 'match_start' }, updatedAt: now - 12,
         startgg: { fullRoundText: 'Winners Round 2', entrants: [{ id: 'E1', name: 'Alice' }, { id: 'E2', name: 'Bob' }] } },
    5: { current: { state: 'idle' }, updatedAt: now - 240, startgg: null },
  });
  renderSets([
    { station: 3, ingestedAt: now - 300, matchedStartggSetId: '111', fullRoundText: 'Winners Round 1',
      entrants: [{ id: 'E1', name: 'Alice' }, { id: 'E2', name: 'Bob' }],
      candidateWinnerEntrantId: 'E1', confidence: 'high', status: 'matched',
      set: { endEpoch: now - 300, winnerName: 'Alice', winnerCharacter: 'clairen',
             players: [{ name: 'Alice', character: 'clairen', wins: 3 }, { name: 'Bob', character: 'zetterburn', wins: 1 }] } },
    { station: 5, ingestedAt: now - 120, matchedStartggSetId: null, fullRoundText: null,
      entrants: null, candidateWinnerEntrantId: null, confidence: 'none', status: 'recorded',
      set: { endEpoch: now - 120, winnerName: 'Cara', winnerCharacter: 'maypul',
             players: [{ name: 'Cara', character: 'maypul', wins: 3 }, { name: 'Dan', character: 'fleet', wins: 2 }] } },
  ]);
  setStatus('Showing demo data (not live).', 'success');
}

// ---- install modal ----------------------------------------------------
// One modal, content swapped per role — same pattern as the tags page's
// guided save-file modal (open/close, Escape, backdrop click).
const INSTALL = {
  mod: {
    title: 'Game PC — install the MatchLogger mod',
    steps: `
      <li>Get a current <strong>experimental</strong> release of
        <a href="https://github.com/UE4SS-RE/RE-UE4SS/releases" target="_blank" rel="noopener">RE-UE4SS</a>
        (Rivals 2 is UE5; the old stable release predates UE5.3+ support) and
        extract it into <code>Rivals2/Binaries/Win64/</code> — the game's own folder.
        You'll end up with a loose <code>dwmapi.dll</code> next to the game exe and
        a <code>ue4ss/</code> folder beside it.</li>
      <li>Download the MatchLogger package below and extract it <strong>into that
        <code>ue4ss/</code> folder</strong>, merging/overwriting
        <code>UE4SS-settings.ini</code>, <code>Mods/mods.txt</code>, and
        <code>Mods/mods.json</code>, and adding <code>Mods/MatchLogger/</code>.</li>
      <li>Delete any <code>enabled.txt</code> file inside other <code>Mods/&lt;Name&gt;/</code>
        folders — it force-enables that mod regardless of <code>mods.txt</code>.</li>
      <li>Launch the game <strong>without Easy Anti-Cheat</strong> (offline/local play
        only — UE4SS can't inject otherwise).</li>
      <li>To disable everything later: delete <code>dwmapi.dll</code>. To reinstall:
        put it back.</li>`,
    download: { href: 'dist/matchlogger-mod.zip', label: 'Download MatchLogger mod (.zip)' },
    note: 'Full details, why each setting is off, and a lag-bisection guide: <a href="ue4ss/README.md">ue4ss/README.md</a>.',
  },
  sender: {
    title: 'Station PC — install the sender',
    steps: `
      <li>Needs <strong>Python 3.8+</strong> installed on this machine.</li>
      <li>Download the sender package below and extract it anywhere (e.g. a
        <code>MatchLoggerSender</code> folder on the Desktop).</li>
      <li>Copy <code>config.example.json</code> to <code>config.json</code> and fill in
        the broker URL, this event's start.gg slug, <strong>this station's number</strong>,
        and <code>dir</code> — the path to the <code>MatchLogger</code> output folder next
        to the game exe (e.g. <code>…/Rivals2/Binaries/Win64/MatchLogger</code>).</li>
      <li>Run the corner widget:
        <code>python station_widget.py --config config.json</code>
        (or <code>station_sender.py</code> for no window at all — that's all stations
        2..N need, since nobody operates them directly).</li>
      <li>Closing the widget sends it to the system tray — it keeps running. Right-click
        the tray icon to reopen or quit it.</li>`,
    download: { href: 'dist/station-sender.zip', label: 'Download station sender (.zip)' },
    note: 'Flags, the tray dependency (<code>pip install pystray pillow</code>), and what it does/doesn\'t touch: <a href="sender/README.md">sender/README.md</a>.',
  },
  operator: {
    title: 'Operator — nothing to install',
    steps: `
      <li>Just keep this page open — on a laptop, the stream PC, or a phone. There's
        no download; it talks straight to the broker.</li>
      <li>Get the <strong>event slug</strong> (the start.gg URL) and enter it above,
        then <strong>Connect</strong>.</li>
      <li>Only if you plan to report results: get the <strong>operator passcode</strong>
        from whoever set up the broker, and enter it above. Viewing never needs it —
        only the Report button does.</li>
      <li>Bookmark the page, or use your browser's "Add to Home Screen" for a
        one-tap launch during the event.</li>`,
  },
};

const installModal = $('installModal');
const installModalBody = $('installModalBody');
const installModalTitle = $('installModalTitle');
const installModalClose = $('installModalClose');

function openInstallModal(kind) {
  const info = INSTALL[kind];
  if (!info || !installModal) return;
  installModalTitle.textContent = info.title;
  const dl = info.download
    ? `<div class="modal-download"><a href="${esc(info.download.href)}"><button type="button">${esc(info.download.label)}</button></a></div>`
    : '';
  const note = info.note ? `<p class="modal-note">${info.note}</p>` : '';
  installModalBody.innerHTML = `<ol class="modal-steps">${info.steps}</ol>${dl}${note}`;
  installModal.hidden = false;
  document.body.classList.add('modal-open');
  installModalClose?.focus();
}

function closeInstallModal() {
  if (!installModal) return;
  installModal.hidden = true;
  document.body.classList.remove('modal-open');
}

if (installModal) {
  document.querySelectorAll('[data-install]').forEach((btn) =>
    btn.addEventListener('click', () => openInstallModal(btn.dataset.install)));
  installModalClose.addEventListener('click', closeInstallModal);
  installModal.addEventListener('click', (e) => { if (e.target === installModal) closeInstallModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !installModal.hidden) closeInstallModal(); });
}

// ---- init -----------------------------------------------------------------
$('brokerInput').value = localStorage.getItem(LS_BROKER) || DEFAULT_BROKER;
const savedSlug = localStorage.getItem(LS_SLUG);
if (savedSlug) $('eventInput').value = savedSlug;
// Passcode is sensitive → sessionStorage only (cleared when the tab closes).
$('passcodeInput').value = sessionStorage.getItem('ml.passcode') || '';
$('passcodeInput').addEventListener('change', () =>
  sessionStorage.setItem('ml.passcode', $('passcodeInput').value));

$('connectBtn').addEventListener('click', connect);
$('eventInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });
$('demoBtn').addEventListener('click', loadDemo);
$('setsBody').addEventListener('click', onSetsClick);

if (savedSlug) connect();
