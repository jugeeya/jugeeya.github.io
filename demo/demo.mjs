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
  installCinematics, resetCursor, glideAndClick, glideAndType,
  showTitleCard, hideTitleCard, showAnnotation, setZoom, smoothScrollToY, sleep,
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
  page.on('download', (d) => d.saveAs(path.join(VIDEO_DIR, 'demo-import.sav')).catch(() => {}));

  await installCinematics(page);
  // Dark the initial blank page so the load shows no white flash.
  await page.evaluate(() => { document.documentElement.style.background = '#0e0c24'; }).catch(() => {});
  await page.goto(TARGET, { waitUntil: 'domcontentloaded' });

  // ── Intro: cover with the title card immediately, load the page BEHIND it,
  // then reveal the whole-page overview and zoom into the top ────────────────
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await setZoom(page, 0.62, 0);    // overview behind the title
  await showTitleCard(page,
    'Rivals II Controls / Tag Sharing',
    'Share your tags and controls, right from the browser', 0, { stay: true });
  // page finishes loading behind the title card (no visible flash)
  await page.locator('#savButton').waitFor();
  await page.locator('#tagBrowser .tag-list-item').first().waitFor({ timeout: 15000 }).catch(() => {});
  resetCursor(W / 2, H / 2);       // cursor stays hidden until the first glide
  await sleep(1500);               // hold the title
  await hideTitleCard(page);       // reveal the whole-page overview
  await sleep(1000);
  await setZoom(page, 1, 1300);    // clean zoom into the submit section
  await sleep(500);

  // The page reads top-to-bottom: the whole submit flow first, then browse.
  // (glide/annotate helpers now smooth-scroll their target into view.)

  // ── 1. Load your save (nothing uploaded) ───────────────────────────────────
  const chooser = page.waitForEvent('filechooser');
  await glideAndClick(page, '#savButton', { settle: 120 });
  await (await chooser).setFiles(SAVE_FILE);
  await page.locator('#savPanel .sav-tag-checkbox').first().waitFor();
  await sleep(400);
  await showAnnotation(page, '#savPanel', 'Read in your browser. Your save is never uploaded.', { ms: 1800, place: 'top' });

  // ── 2. Pick the HYPER tag and stage it ─────────────────────────────────────
  const hyperSel = '#savPanel .sav-tag-checkbox[value="HYPER"]';
  const tagSel = (await page.locator(hyperSel).count()) ? hyperSel : '#savPanel .sav-tag-checkbox >> nth=0';
  await glideAndClick(page, tagSel);
  await sleep(250);
  await glideAndClick(page, '#savPanel #savAddBtn');
  await page.locator('#fileList .sgg-input').first().waitFor();
  await sleep(350);

  // ── 3. Link HYPER to HyperFlame's start.gg (live search, real avatars) ─────
  await showAnnotation(page, '#fileList', 'Link each tag to its own start.gg account', { ms: 1700, place: 'top' });
  await glideAndType(page, '#fileList .sgg-input', 'HyperFlame', { perChar: 72 });
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
  await (await chooser2).setFiles(SAVE_FILE);
  await sleep(1100);
  await showAnnotation(page, '#importStatus', 'Import a whole bracket into your own .sav', { ms: 1900, place: 'top' });
  await sleep(600);

  // ── Outro: title card that holds to the end (no second overview) ───────────
  await showTitleCard(page, 'jugeeya.github.io/tags', 'No installs. No uploads. Just share.', 2200, { stay: true });

  await page.close();
  await context.close();
  await browser.close();

  const video = await page.video()?.path();
  console.log(`\n✅ Recorded: ${video}\n` +
    `Convert + add music (optional):\n` +
    `   ffmpeg -i "${video}" -vf "fps=30,scale=${W}:${H}" -c:v libx264 -pix_fmt yuv420p -crf 20 demo.mp4\n`);
};

run().catch((e) => { console.error(e); process.exit(1); });
