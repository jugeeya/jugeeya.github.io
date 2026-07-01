// Records a polished demo video of the Rivals II Controls / Tag Sharing tool.
//
//   node demo.mjs                # records to videos/, prints the file path
//   SAVE_FILE=/path/to.sav node demo.mjs
//   TARGET=http://localhost:8000/tags/ node demo.mjs   # (won't reach the worker; see README)
//
// Runs against the LIVE site by default so start.gg + the manifest work (the
// broker only allows the jugeeya.github.io origin). Two endpoints are mocked so
// the demo is deterministic and side-effect-free:
//   - the bracket lookup (returns the currently-published tags as "entrants")
//   - the submit POST (no real pull request is opened)

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  installCinematics, resetCursor, glideAndClick, glideAndType,
  showTitleCard, hideTitleCard, revealPage, showAnnotation, setZoom, smoothScrollToY, sleep,
} from './lib.mjs';

const TARGET = process.env.TARGET || 'https://jugeeya.github.io/tags/';
const ORIGIN = new URL(TARGET).origin;
// When not driving the real site (e.g. CI records a locally-served copy), the
// start.gg endpoints are mocked so the recording is deterministic and offline.
const LIVE = ORIGIN === 'https://jugeeya.github.io';
const SAVE_FILE = process.env.SAVE_FILE
  || fileURLToPath(new URL('./fixtures/demo-save.sav', import.meta.url));
const VIDEO_DIR = fileURLToPath(new URL('./videos', import.meta.url));
const W = 1280, H = 720;
// Content is scaled up a touch so text stays legible when the 16:9 video is
// shown small on a phone.
const ZOOM = 1.2;
const BROKER = 'https://r2tag-broker.jdsambasivam.workers.dev';

// A tiny inline avatar for mocked start.gg results (no network needed).
const MOCK_AVATAR = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
  '<circle cx="32" cy="32" r="32" fill="#6c63ff"/>' +
  '<text x="32" y="43" font-size="30" fill="#fff" text-anchor="middle" ' +
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

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 2,
    acceptDownloads: true,
    reducedMotion: 'no-preference', // keep CSS transitions/animations alive
    recordVideo: { dir: VIDEO_DIR, size: { width: W, height: H } },
  });
  const page = await context.newPage();

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

  page.on('download', (d) => d.saveAs(path.join(VIDEO_DIR, 'demo-import.sav')).catch(() => {}));

  await installCinematics(page);
  // Force the classic file-input + download path for import: the File System
  // Access pickers are native dialogs Playwright can't script, so the demo
  // drives the fallback (which produces a downloadable .sav).
  await page.addInitScript(() => {
    try { delete window.showOpenFilePicker; } catch { /* ignore */ }
    try { delete window.showSaveFilePicker; } catch { /* ignore */ }
  });
  await page.goto(TARGET, { waitUntil: 'domcontentloaded' });

  // ── Intro: the page body is hidden from first paint (installCinematics CSS),
  // so it never flashes. We raise the title card, load + stage the page behind
  // it, reveal the whole-page overview, then zoom into the top ────────────────
  await showTitleCard(page,
    'Rivals II Controls / Tag Sharing',
    'Share your tags and controls, right from the browser', 0, { stay: true });
  // Load + stage the page behind the title card (body still hidden).
  await page.locator('#savButton').waitFor({ state: 'attached' });
  await page.locator('#tagBrowser .tag-list-item').first().waitFor({ state: 'attached', timeout: 15000 }).catch(() => {});
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await setZoom(page, 0.62, 0);    // overview scale, staged behind the title
  await revealPage(page);          // un-hide the body (still covered by the card)
  resetCursor(W / 2, H / 2);       // cursor stays hidden until the first glide
  await sleep(1500);               // hold the title
  await hideTitleCard(page);       // reveal the whole-page overview
  await sleep(900);
  await setZoom(page, ZOOM, 1300);  // clean zoom into the submit section
  await sleep(400);

  // The page reads top-to-bottom: the whole submit flow first, then browse.
  // (glide/annotate helpers now smooth-scroll their target into view.)

  // ── 1. Load your save (nothing uploaded) ───────────────────────────────────
  const chooser = page.waitForEvent('filechooser');
  await glideAndClick(page, '#savButton', { settle: 120 });
  await (await chooser).setFiles(SAVE_UPLOAD);
  await page.locator('#savPanel .sav-tag-checkbox').first().waitFor();
  await sleep(300);
  await showAnnotation(page, '#savPanel', 'Read in your browser. Your save is never uploaded.', { ms: 1500, place: 'top' });

  // ── 2. Pick the HYPER tag and stage it ─────────────────────────────────────
  const hyperSel = '#savPanel .sav-tag-checkbox[value="HYPER"]';
  const tagSel = (await page.locator(hyperSel).count()) ? hyperSel : '#savPanel .sav-tag-checkbox >> nth=0';
  await glideAndClick(page, tagSel, { settle: 70 });
  await sleep(90);
  await glideAndClick(page, '#savPanel #savAddBtn', { settle: 70 });
  await page.locator('#fileList .sgg-input').first().waitFor();
  await sleep(180);

  // ── 3. Link HYPER to HyperFlame's start.gg (live search, real avatars) ─────
  await showAnnotation(page, '#fileList', 'Link each tag to its own start.gg account', { ms: 1100, place: 'top' });
  await glideAndType(page, '#fileList .sgg-input', 'HyperFlame', { perChar: 55 });
  try {
    await page.locator('#fileList .sgg-result').first().waitFor({ timeout: 6000 });
  } catch { /* live search may be slow; continue anyway */ }
  await sleep(650);
  // Pick HyperFlame's actual account (the one the published HYPER tag uses).
  let pick = page.locator('#fileList .sgg-result').first();
  if (hyper) {
    const match = page.locator('#fileList .sgg-result').filter({ hasText: hyper.startgg.slug });
    if (await match.count()) pick = match.first();
  }
  await glideAndClick(page, pick);
  await sleep(700);

  // ── 4. Submit (mocked — no real PR) ────────────────────────────────────────
  await glideAndClick(page, '#submitButton');
  await page.locator('#pendingPanel').waitFor({ state: 'visible' }).catch(() => {});
  await sleep(750);
  // Annotate the "Your submissions" panel (the success line auto-clears).
  await showAnnotation(page, '#pendingPanel', "Submitted — it's now in the shared database below.", { ms: 1900, place: 'top' });
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
  await showAnnotation(page, '#tagSearch', 'A shared database of tags + custom controls', { ms: 1600, place: 'top' });
  await glideAndType(page, '#tagSearch', 'Hyper', { perChar: 95 });
  await sleep(700);
  await glideAndClick(page, '#tagList .tag-diff-toggle');
  await page.locator('#tagList .tag-diff-panel .tag-diff-body').waitFor();
  await page.waitForFunction(() => {
    const b = document.querySelector('#tagList .tag-diff-panel .tag-diff-body');
    return b && !/Loading/.test(b.textContent);
  }, { timeout: 8000 }).catch(() => {});
  await sleep(400);
  await showAnnotation(page, '#tagList .tag-diff-panel', 'See exactly which controls a tag changes', { ms: 2000, place: 'top' });
  await sleep(400);
  await glideAndType(page, '#tagSearch', '', { perChar: 0 }); // clear → all tags again
  await sleep(450);

  // ── 6. Download a whole bracket ────────────────────────────────────────────
  await glideAndType(page, '#bracketInput', 'https://www.start.gg/tournament/demo-invitational/event/singles', { perChar: 16 });
  await glideAndClick(page, '#bracketGo');
  await sleep(1000);
  await showAnnotation(page, '#bracketStatus', "Paste a bracket URL to grab every entrant's tag", { ms: 1800 });
  await sleep(350);

  // ── 7. Import the bracket straight into a save ─────────────────────────────
  const chooser2 = page.waitForEvent('filechooser');
  await glideAndClick(page, '#importSelected', { settle: 120 });
  await (await chooser2).setFiles(SAVE_UPLOAD);
  await sleep(1100);
  await showAnnotation(page, '#importStatus', 'Import a whole bracket into your own .sav', { ms: 1900, place: 'top' });
  await sleep(1100);               // brief hold on the final state (no outro card)

  await page.close();
  await context.close();
  await browser.close();

  const video = await page.video()?.path();
  // -ss 0.5 trims the unavoidable first-frame blank (the video records from
  // page creation, before anything can paint).
  console.log(`\n✅ Recorded: ${video}\n` +
    `Convert + add music (optional):\n` +
    `   ffmpeg -ss 0.5 -i "${video}" -vf "fps=30,scale=${W}:${H}" -c:v libx264 -pix_fmt yuv420p -crf 20 demo.mp4\n`);
};

run().catch((e) => { console.error(e); process.exit(1); });
