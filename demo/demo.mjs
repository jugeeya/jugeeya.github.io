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
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  installCinematics, resetCursor, moveCursorTo, glideAndClick, glideAndType,
  showTitleCard, showAnnotation, sleep,
} from './lib.mjs';

const TARGET = process.env.TARGET || 'https://jugeeya.github.io/tags/';
const ORIGIN = new URL(TARGET).origin;
const SAVE_FILE = process.env.SAVE_FILE
  || fileURLToPath(new URL('./fixtures/demo-save.sav', import.meta.url));
const VIDEO_DIR = fileURLToPath(new URL('./videos', import.meta.url));
const W = 1280, H = 720;
const BROKER = 'https://r2tag-broker.jdsambasivam.workers.dev';

if (!existsSync(SAVE_FILE)) {
  console.error(`\nNo save file at: ${SAVE_FILE}\n` +
    `Point SAVE_FILE at your real Rivals2_PlayerTagSaveSlot.sav, or run:\n` +
    `   node generate-fixture.mjs\n`);
  process.exit(1);
}

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
  page.on('download', (d) => d.saveAs(path.join(VIDEO_DIR, 'demo-import.sav')).catch(() => {}));

  await installCinematics(page);
  await page.goto(TARGET, { waitUntil: 'networkidle' });
  resetCursor(W / 2, H / 2);
  await page.evaluate(([x, y]) => window.__cine && window.__cine.move(x, y), [W / 2, H / 2]);
  await sleep(600);

  // ── Title ────────────────────────────────────────────────────────────────
  await showTitleCard(page,
    'Rivals II Controls / Tag Sharing',
    'Share your tags and controls, right from the browser', 2800);

  // The page reads top-to-bottom — submit first, then browse/download — so the
  // demo follows the same order instead of jumping around.

  // ── 1. Load your save (nothing uploaded) ───────────────────────────────────
  await page.locator('#savButton').scrollIntoViewIfNeeded();
  await sleep(400);
  const chooser = page.waitForEvent('filechooser');
  await glideAndClick(page, '#savButton', { settle: 120 });
  await (await chooser).setFiles(SAVE_FILE);
  await page.locator('#savPanel .sav-tag-checkbox').first().waitFor();
  await sleep(700);
  await showAnnotation(page, '#savPanel', 'Read in your browser. Your save is never uploaded.', { ms: 2600, place: 'top' });

  // ── 2. Pick the HYPER tag and stage it ─────────────────────────────────────
  const hyperSel = '#savPanel .sav-tag-checkbox[value="HYPER"]';
  const tagSel = (await page.locator(hyperSel).count()) ? hyperSel : '#savPanel .sav-tag-checkbox >> nth=0';
  await glideAndClick(page, tagSel);
  await sleep(400);
  await glideAndClick(page, '#savPanel #savAddBtn');
  await page.locator('#fileList .sgg-input').first().waitFor();
  await sleep(700);

  // ── 3. Link HYPER to HyperFlame's start.gg (live search, real avatars) ─────
  await showAnnotation(page, '#fileList', 'Link each tag to its own start.gg account', { ms: 2400, place: 'top' });
  await glideAndType(page, '#fileList .sgg-input', 'HyperFlame', { perChar: 85 });
  try {
    await page.locator('#fileList .sgg-result').first().waitFor({ timeout: 6000 });
  } catch { /* live search may be slow; continue anyway */ }
  await sleep(900);
  // Pick HyperFlame's actual account (the one the published HYPER tag uses),
  // not just whichever match happens to rank first.
  let pick = page.locator('#fileList .sgg-result').first();
  if (hyper) {
    const match = page.locator('#fileList .sgg-result').filter({ hasText: hyper.startgg.slug });
    if (await match.count()) pick = match.first();
  }
  await glideAndClick(page, pick);
  await sleep(900);

  // ── 4. Submit (mocked — no real PR) ────────────────────────────────────────
  await glideAndClick(page, '#submitButton');
  await sleep(1400);
  await showAnnotation(page, '#uploadStatus', 'Submitted! It is now in the database for your TOs.', { ms: 2800, place: 'top' });
  await sleep(600);

  // ── 5. Browse the database ─────────────────────────────────────────────────
  await page.locator('#tagBrowser').scrollIntoViewIfNeeded();
  await sleep(500);
  await showAnnotation(page, '#tagBrowser', 'A shared database of player tags + custom controls', { ms: 2200 });
  await glideAndType(page, '#tagSearch', 'kim', { perChar: 110 });
  await sleep(1200);
  await showAnnotation(page, '#tagSearch', 'Search by in-game tag or start.gg account', { ms: 2000, place: 'top' });
  await glideAndType(page, '#tagSearch', '', { perChar: 0 });
  await sleep(800);

  // ── 6. Download a whole bracket ────────────────────────────────────────────
  await glideAndType(page, '#bracketInput', 'https://www.start.gg/tournament/demo-invitational/event/singles', { perChar: 22 });
  await glideAndClick(page, '#bracketGo');
  await sleep(1400);
  await showAnnotation(page, '#bracketStatus', "Paste a bracket URL to grab every entrant's tag", { ms: 2600 });
  await sleep(600);

  // ── 7. Import the bracket straight into a save ─────────────────────────────
  await page.locator('#importSelected').scrollIntoViewIfNeeded();
  await sleep(400);
  const chooser2 = page.waitForEvent('filechooser');
  await glideAndClick(page, '#importSelected', { settle: 120 });
  await (await chooser2).setFiles(SAVE_FILE);
  await sleep(1600);
  await showAnnotation(page, '#importStatus', 'Import a whole bracket into your own .sav', { ms: 2800, place: 'top' });
  await sleep(800);

  // ── Outro ──────────────────────────────────────────────────────────────────
  await showTitleCard(page, 'jugeeya.github.io/tags', 'No installs. No uploads. Just share.', 2800);

  await page.close();
  await context.close();
  await browser.close();

  const video = await page.video()?.path();
  console.log(`\n✅ Recorded: ${video}\n` +
    `Convert + add music (optional):\n` +
    `   ffmpeg -i "${video}" -vf "fps=30,scale=${W}:${H}" -c:v libx264 -pix_fmt yuv420p -crf 20 demo.mp4\n`);
};

run().catch((e) => { console.error(e); process.exit(1); });
