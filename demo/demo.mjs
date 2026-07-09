// Records a polished demo video of the Rivals II Controls / Tag Sharing tool.
//
//   node demo.mjs                # writes demo.mp4 directly, prints frame count
//   SAVE_FILE=/path/to.sav node demo.mjs
//   TARGET=http://localhost:8000/tags/ node demo.mjs   # (won't reach the worker; see README)
//
// Runs against the LIVE site by default so start.gg + the manifest work (the
// broker only allows the jugeeya.github.io origin). Two endpoints are mocked so
// the demo is deterministic and side-effect-free:
//   - the bracket lookup (returns the currently-published tags as "entrants")
//   - the submit POST (no real pull request is opened)
//
// Video capture goes through playwright-recorder-plus rather than Playwright's
// built-in recordVideo: recordVideo hardcodes a low-bitrate VP8 encode that
// shows up as visible "mosquito noise" once re-encoded, and Chromium's CDP
// screencast (which both mechanisms are built on) is capped to a real ~15-16fps
// in this headless environment regardless of resolution/quality -- confirmed
// empirically, not a config knob either tool exposes. recorder-plus instead
// hands us clean JPEG frames (quality 100) which we pipe through our own
// second-pass ffmpeg filter chain: hqdn3d denoise + minterpolate(mi_mode=blend)
// to a genuine 50fps + crf 18, the same fix applied when this was still a
// separate post-process step over recordVideo's output. At equal crf this
// produces ~45% smaller files with no measurable per-pixel quality loss on
// static content (A/B'd via ffmpeg's difference blend mode) -- because it's
// no longer spending bits re-encoding VP8's noise floor.

import { chromium } from 'playwright';
import { attachRecorder } from 'playwright-recorder-plus';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  installCinematics, resetCursor, glideAndClick, glideAndType,
  revealPage, showAnnotation, setZoom, smoothScrollToY, sleep,
} from './lib.mjs';

const TARGET = process.env.TARGET || 'https://jugeeya.github.io/tags/';
const ORIGIN = new URL(TARGET).origin;
// When not driving the real site (e.g. CI records a locally-served copy), the
// start.gg endpoints are mocked so the recording is deterministic and offline.
const LIVE = ORIGIN === 'https://jugeeya.github.io';
const SAVE_FILE = process.env.SAVE_FILE
  || fileURLToPath(new URL('./fixtures/demo-save.sav', import.meta.url));
const OUT_VIDEO = fileURLToPath(new URL('./demo.mp4', import.meta.url));
// Scratch dir for artifacts that aren't the final video (just the .sav the
// import step downloads mid-run).
const SCRATCH_DIR = fileURLToPath(new URL('./tmp', import.meta.url));
// Playwright's screencast delivers frames at the viewport's CSS-pixel size
// regardless of deviceScaleFactor (Chromium supersamples internally, then
// downsamples to exactly this size before sending) -- deviceScaleFactor 2
// keeps text crisp through that downsample without inflating frame dimensions.
const W = 1920, H = 1080;
const DSF = 2;
// Content is scaled up so it nearly fills the 1920px frame (the site's ~1000px
// container leaves only a thin margin at this scale) — big and legible, and it
// reads well when the video is shown small on a phone.
const ZOOM = 1.9;
const BROKER = 'https://r2tag-broker.jdsambasivam.workers.dev';

// A tiny inline avatar for mocked start.gg results (no network needed).
const MOCK_AVATAR = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
  '<circle cx="32" cy="32" r="32" fill="#8fd3e8"/>' +
  '<text x="32" y="43" font-size="30" fill="#06323b" text-anchor="middle" ' +
  'font-family="sans-serif">H</text></svg>');

if (!existsSync(SAVE_FILE)) {
  console.error(`\nNo save file at: ${SAVE_FILE}\n` +
    `Point SAVE_FILE at your real Rivals2_PlayerTagSaveSlot.sav, or run:\n` +
    `   node generate-fixture.mjs\n`);
  process.exit(1);
}

// Present the chosen save under the real in-game filename, so the demo matches
// what users actually load (not the fixture's name).
const SAVE_UPLOAD = {
  name: 'Rivals2_PlayerTagSaveSlot.sav',
  mimeType: 'application/octet-stream',
  buffer: readFileSync(SAVE_FILE),
};

// The live tag manifest (so the mocked bracket selects real entries, and we can
// link HYPER to the exact start.gg account it's published under).
async function loadIndex() {
  try {
    const res = await fetch(`${ORIGIN}/tags/data/index.json`);
    return await res.json();
  } catch {
    return { tags: [] };
  }
}

const run = async () => {
  const index = await loadIndex();
  const tags = index.tags || [];
  const entrants = tags
    .filter((t) => t.startgg && t.startgg.slug)
    .map((t) => ({ entrant: t.startgg.tag || t.name, gamerTag: t.startgg.tag || t.name, slug: t.startgg.slug }));
  const hyper = tags.find((t) => (t.name || '').toUpperCase() === 'HYPER' && t.startgg && t.startgg.slug);

  mkdirSync(SCRATCH_DIR, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: DSF,
    acceptDownloads: true,
    reducedMotion: 'no-preference', // keep CSS transitions/animations alive
    permissions: ['clipboard-write'], // so the modal's "Copy path" shows "Copied ✓"
  });
  const page = await context.newPage();
  // Dark the initial about:blank so the recorder's very first frames (captured
  // before the site has loaded) aren't the browser's white default. Once the
  // real page loads, installCinematics' curtain + html background keep it dark
  // through staging until revealPage fades in.
  await page.evaluate(() => { document.documentElement.style.background = '#141218'; }).catch(() => {});

  // Attach before navigating (per playwright-recorder-plus's own quick-start
  // ordering) so nothing repaints before the screencast is listening. Second
  // pass mirrors the denoise + blend-interpolate-to-50fps chain this repo
  // already validated as a fix for Playwright's built-in-recorder choppiness.
  const recorder = await attachRecorder(page, {
    path: OUT_VIDEO,
    fps: 25,
    jpegQuality: 100,
    ffmpegArgs: [
      '-vf', 'hqdn3d=1.2:1.0:6:4,minterpolate=fps=50:mi_mode=blend,scale=1920:1080:flags=lanczos',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    ],
  });

  // Mock the bracket lookup so it matches the live published tags.
  await page.route('**/startgg/event*', (route) =>
    route.fulfill({ json: { event: 'Demo Invitational 2026', entrants } }));
  // Mock the submit so no real PR is opened.
  await page.route(`${BROKER}/`, (route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill({
        json: { ok: true, pr: 'https://github.com/jugeeya/jugeeya.github.io/pull/42', number: 42 },
      });
    }
    return route.continue();
  });

  // Offline recording (e.g. CI against a local copy): mock the start.gg search
  // so linking HYPER to HyperFlame's account works without the live broker.
  if (!LIVE) {
    const hyperSlug = (hyper && hyper.startgg && hyper.startgg.slug) || 'user/8ada046a';
    const mockPlayers = [
      { slug: hyperSlug, gamerTag: 'HyperFlame', prefix: '', image: MOCK_AVATAR },
      { slug: 'user/hypernova', gamerTag: 'HyperNova', prefix: 'RA', image: MOCK_AVATAR },
      { slug: 'user/hyperion', gamerTag: 'Hyperion', prefix: '', image: MOCK_AVATAR },
    ];
    await page.route('**/startgg/search*', (route) =>
      route.fulfill({ json: { players: mockPlayers, totalPages: 1 } }));
    await page.route('**/startgg/user*', (route) =>
      route.fulfill({ json: mockPlayers[0] }));
  }

  page.on('download', (d) => d.saveAs(path.join(SCRATCH_DIR, 'demo-import.sav')).catch(() => {}));

  await installCinematics(page);
  // Force the classic file-input + download path for import: the File System
  // Access pickers are native dialogs Playwright can't script, so the demo
  // drives the fallback (which produces a downloadable .sav).
  await page.addInitScript(() => {
    try { delete window.showOpenFilePicker; } catch { /* ignore */ }
    try { delete window.showSaveFilePicker; } catch { /* ignore */ }
  });
  await page.goto(TARGET, { waitUntil: 'domcontentloaded' });
  // Recording-only overrides:
  //  - hide the page's own embedded demo video (no picture-in-picture of itself);
  //  - force the single, centered column the walkthrough is built around. The
  //    live desktop layout is a wide two-column grid, but the demo zooms in hard
  //    (transform: scale) about the top-centre, which would push a side column
  //    off-screen — so collapse to one narrower column that stays fully on-frame.
  await page.addStyleTag({ content: `
    .demo-video { display: none !important; }
    @media (min-width: 1024px) {
      .container-wide { max-width: 900px !important; }
      main { display: block !important; max-width: 900px !important; }
      #shareFlow, #pendingPanel, #getFlow { grid-column: auto !important; grid-row: auto !important; margin: 0 0 1.5rem !important; }
      .back-link + header { display: block !important; }
    }
  ` }).catch(() => {});

  // ── Intro: the page body is hidden from first paint (installCinematics CSS),
  // so nothing flashes while we stage it. Load, scroll to top, zoom into the
  // submit section, then reveal — no title card, straight into the tool. ──────
  await page.locator('#savButton').waitFor({ state: 'attached' });
  await page.locator('#tagBrowser .tag-list-item').first().waitFor({ state: 'attached', timeout: 15000 }).catch(() => {});
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await setZoom(page, ZOOM, 0);    // start already zoomed into the submit section
  await revealPage(page);          // un-hide the fully-staged page
  resetCursor(W / 2, H / 2);       // cursor stays hidden until the first glide
  await sleep(900);                // brief hold on the opening frame

  // The page reads top-to-bottom: the whole submit flow first, then browse.
  // (glide/annotate helpers now smooth-scroll their target into view.)

  // ── 1. Load your save — through the guided modal (copy path → choose file) ──
  await glideAndClick(page, '#savButton', { settle: 120 });
  await page.locator('#saveModal').waitFor({ state: 'visible' });
  await sleep(550);
  await glideAndClick(page, '#saveModal .copy-path-btn', { settle: 150 }); // step 1
  await sleep(750);
  const chooser = page.waitForEvent('filechooser');
  await glideAndClick(page, '#saveModalChoose', { settle: 150 });          // step 2
  await (await chooser).setFiles(SAVE_UPLOAD);
  await page.locator('#shareTagList .share-tag-checkbox').first().waitFor();
  await sleep(300);
  await showAnnotation(page, '#shareLoadedNote', 'Read in your browser. Your save is never uploaded.', { ms: 1500 });

  // ── 2. Select the HYPER tag — exports it and reveals its own start.gg picker
  //      inline on the row (no separate "add to submission" step anymore) ─────
  const hyperSel = '#shareTagList .share-tag-checkbox[value="HYPER"]';
  const tagSel = (await page.locator(hyperSel).count()) ? hyperSel : '#shareTagList .share-tag-checkbox >> nth=0';
  await glideAndClick(page, tagSel, { settle: 70 });
  await page.locator('.share-tag-item.is-selected .sgg-input').waitFor({ timeout: 8000 });
  await sleep(180);

  // ── 3. Link HYPER to HyperFlame's start.gg (live search, real avatars) ─────
  await showAnnotation(page, '.share-tag-item.is-selected', 'Link each tag to its own start.gg account', { ms: 1100 });
  await glideAndType(page, '.share-tag-item.is-selected .sgg-input', 'HyperFlame', { perChar: 55 });
  try {
    await page.locator('.share-tag-item.is-selected .sgg-result').first().waitFor({ timeout: 6000 });
  } catch { /* live search may be slow; continue anyway */ }
  await sleep(650);
  // Pick HyperFlame's actual account (the one the published HYPER tag uses).
  let pick = page.locator('.share-tag-item.is-selected .sgg-result').first();
  if (hyper) {
    const match = page.locator('.share-tag-item.is-selected .sgg-result').filter({ hasText: hyper.startgg.slug });
    if (await match.count()) pick = match.first();
  }
  await glideAndClick(page, pick);
  await sleep(700);

  // ── 4. Submit (mocked — no real PR) ────────────────────────────────────────
  await glideAndClick(page, '#submitButton');
  await page.locator('#pendingPanel').waitFor({ state: 'visible' }).catch(() => {});
  await sleep(750);
  // Annotate the "Your submissions" panel (the success line auto-clears).
  await showAnnotation(page, '#pendingPanel', "Submitted — it's now in the shared database below.", { ms: 1900 });
  await sleep(400);

  // ── 5. Browse + view a tag's actual control changes ────────────────────────
  // Eased-scroll to frame the whole Shared-tags section (heading included).
  {
    const dest = await page.evaluate(() => {
      const sec = document.querySelector('#tagBrowser')?.closest('.panel');
      return sec ? window.scrollY + sec.getBoundingClientRect().top - 28 : null;
    });
    if (dest != null) await smoothScrollToY(page, dest, 750);
  }
  await sleep(350);
  await showAnnotation(page, '#tagSearch', 'A shared database of tags + custom controls', { ms: 1600 });
  await glideAndType(page, '#tagSearch', 'Hyper', { perChar: 95 });
  await sleep(700);
  await glideAndClick(page, '#tagList .tag-diff-toggle');
  await page.locator('#tagList .tag-diff-panel .tag-diff-body').waitFor();
  await page.waitForFunction(() => {
    const b = document.querySelector('#tagList .tag-diff-panel .tag-diff-body');
    return b && !/Loading/.test(b.textContent);
  }, { timeout: 8000 }).catch(() => {});
  await sleep(400);
  await showAnnotation(page, '#tagList .tag-diff-panel', 'See exactly which controls a tag changes', { ms: 2000 });
  await sleep(400);
  await glideAndType(page, '#tagSearch', '', { perChar: 0 }); // clear → all tags again
  await sleep(450);

  // ── 6. Download a whole bracket ────────────────────────────────────────────
  await glideAndType(page, '#bracketInput', 'https://www.start.gg/tournament/demo-invitational/event/singles', { perChar: 16 });
  await glideAndClick(page, '#bracketGo');
  await sleep(1000);
  await showAnnotation(page, '#bracketStatus', "Paste a bracket URL to grab every entrant's tag", { ms: 1800 });
  await sleep(350);

  // ── 7. Import the bracket straight into a save (same guided modal) ─────────
  await glideAndClick(page, '#importSelected', { settle: 120 });
  await page.locator('#saveModal').waitFor({ state: 'visible' });
  await sleep(500);
  await glideAndClick(page, '#saveModal .copy-path-btn', { settle: 150 });
  await sleep(650);
  const chooser2 = page.waitForEvent('filechooser');
  await glideAndClick(page, '#saveModalChoose', { settle: 150 });
  await (await chooser2).setFiles(SAVE_UPLOAD);
  await sleep(1100);
  await showAnnotation(page, '#importStatus', 'Import a whole bracket into your own .sav', { ms: 1900 });
  await sleep(1100);               // brief hold on the final state (no outro card)

  // stop() flushes the (fast, ultrafast-h264) first pass; our denoise +
  // interpolate second pass then runs in the background while the browser
  // tears down, so it's not holding Chromium open for no reason.
  await recorder.stop();
  await page.close();
  await context.close();
  await browser.close();
  const result = await recorder.finalized;

  console.log(`\n✅ Recorded: ${result.path} (${result.frameCount} pass-1 frames, incl. CFR padding)\n` +
    `Generate the poster (revealed page, just after the opening fade):\n` +
    `   ffmpeg -y -ss 2.5 -i demo.mp4 -frames:v 1 -q:v 3 demo-poster.jpg\n`);
};

run().catch((e) => { console.error(e); process.exit(1); });
