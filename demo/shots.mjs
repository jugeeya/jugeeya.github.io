// Generates the high-quality screenshots shown as the clickable gallery in the
// tags page hero. Replaces the old Playwright video recorder (a walkthrough
// video was fiddly to get right; a few crisp stills read better and never
// drift out of sync).
//
//   node shots.mjs                                    # -> ../tags/shots/*.png (live site)
//   TARGET=http://localhost:8848/tags/ node shots.mjs # against a local copy
//
// Drives the real UI into a few representative states at a phone-ish width
// (the site's single-column layout) and captures the viewport at 3x for
// retina-crisp output. start.gg + submit are mocked so it's deterministic and
// side-effect-free, exactly as the recorder was.

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';

const TARGET = process.env.TARGET || 'https://jugeeya.github.io/tags/';
const ORIGIN = new URL(TARGET).origin;
const LIVE = ORIGIN === 'https://jugeeya.github.io';
const SAVE_FILE = process.env.SAVE_FILE
  || fileURLToPath(new URL('./fixtures/demo-save.sav', import.meta.url));
const OUT_DIR = fileURLToPath(new URL('../tags/shots/', import.meta.url));

// Phone-ish width so we get the single-column flow (the two-column desktop grid
// would be too wide/sparse for a hero thumbnail). 3x device scale keeps text
// crisp when the shot is enlarged in the lightbox.
const W = 440, H = 900, DSF = 3;
const BROKER = 'https://r2tag-broker.jdsambasivam.workers.dev';

const MOCK_AVATAR = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
  '<circle cx="32" cy="32" r="32" fill="#8fd3e8"/>' +
  '<text x="32" y="43" font-size="30" fill="#06323b" text-anchor="middle" ' +
  'font-family="sans-serif">J</text></svg>');

if (!existsSync(SAVE_FILE)) {
  console.error(`\nNo save file at: ${SAVE_FILE}\n   run: node generate-fixture.mjs\n`);
  process.exit(1);
}
const SAVE_UPLOAD = {
  name: 'Rivals2_PlayerTagSaveSlot.sav',
  mimeType: 'application/octet-stream',
  buffer: readFileSync(SAVE_FILE),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Scroll so a given element sits `topGap` px below the top of the viewport,
// then capture the whole viewport — this frames a shot the way the examples do
// (section heading at the top, cut off naturally at the bottom).
async function frameAndShoot(page, anchorSel, name, { topGap = 24 } = {}) {
  await page.evaluate(({ anchorSel, topGap }) => {
    const el = document.querySelector(anchorSel);
    if (el) window.scrollTo(0, window.scrollY + el.getBoundingClientRect().top - topGap);
  }, { anchorSel, topGap });
  await sleep(250);
  await page.screenshot({ path: `${OUT_DIR}${name}.png` });
  console.log(`  wrote ${name}.png`);
}

const run = async () => {
  mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: DSF,
    reducedMotion: 'reduce', // freeze entrance animations for clean stills
  });
  const page = await context.newPage();

  // Deterministic start.gg (search + single-user lookup) with a mock avatar,
  // the bracket lookup, and a no-op submit.
  const mockPlayers = [
    { slug: 'user/6192f6f1', gamerTag: 'jugeeya', prefix: '', image: MOCK_AVATAR },
    { slug: 'user/jugz2', gamerTag: 'jugz', prefix: 'RA', image: MOCK_AVATAR },
  ];
  await page.route('**/startgg/search*', (r) => r.fulfill({ json: { players: mockPlayers, totalPages: 1 } }));
  await page.route('**/startgg/user*', (r) => r.fulfill({ json: mockPlayers[0] }));
  await page.route('**/startgg/event*', (r) => r.fulfill({ json: { event: 'Demo Invitational 2026', entrants: [] } }));
  await page.route(`${BROKER}/`, (r) =>
    r.request().method() === 'POST'
      ? r.fulfill({ json: { ok: true, pr: 'https://github.com/x/y/pull/42', number: 42 } })
      : r.continue());

  // Force the classic file-input path (the File System Access picker is a native
  // dialog Playwright can't drive).
  await page.addInitScript(() => {
    try { delete window.showOpenFilePicker; } catch { /* ignore */ }
  });
  await page.goto(TARGET, { waitUntil: 'domcontentloaded' });
  // Hide the hero gallery itself so the screenshots never show themselves.
  await page.addStyleTag({ content: '.demo-gallery, .demo-video { display: none !important; }' });
  await page.locator('#tagBrowser .tag-list-item, #getFlow .tag-list-empty').first()
    .waitFor({ state: 'attached', timeout: 15000 }).catch(() => {});

  // ── Shot 1: Share flow — save loaded, a tag ticked, start.gg picker open ────
  {
    const input = page.locator('#savInput');
    await input.setInputFiles(SAVE_UPLOAD);
    await page.locator('#shareTagList .share-tag-checkbox').first().waitFor();
    // Tick JUGZ! (falls back to the first tag if the fixture lacks it).
    const jugz = page.locator('#shareTagList .share-tag-checkbox[value="JUGZ!"]');
    const cb = (await jugz.count()) ? jugz : page.locator('#shareTagList .share-tag-checkbox').first();
    await cb.check();
    const row = page.locator('#shareTagList .share-tag-item.is-selected');
    await row.locator('.sgg-input').waitFor({ timeout: 8000 });
    await row.locator('.sgg-input').fill('jugeeya');
    await row.locator('.sgg-result').first().waitFor({ timeout: 6000 }).catch(() => {});
    await sleep(300);
    await frameAndShoot(page, '#shareFlow .flow-head', 'share');
  }

  // ── Shot 2: Install flow — a tag selected with its "View changes" diff open ──
  {
    await page.evaluate(() => window.scrollTo(0, 0));
    const firstDiff = page.locator('#tagList .tag-diff-toggle').first();
    if (await firstDiff.count()) {
      // Select the tag whose changes we're opening, so it reads as "chosen".
      const li = firstDiff.locator('xpath=ancestor::li[contains(@class,"tag-list-item")]');
      await li.locator('.tag-checkbox').check().catch(() => {});
      await firstDiff.click();
      await page.locator('#tagList .tag-diff-panel .tag-diff-body').waitFor({ timeout: 8000 });
      await page.waitForFunction(() => {
        const b = document.querySelector('#tagList .tag-diff-panel .tag-diff-body');
        return b && !/Loading/.test(b.textContent);
      }, { timeout: 8000 }).catch(() => {});
      await sleep(300);
    }
    await frameAndShoot(page, '#getFlow .flow-head', 'install');
  }

  await browser.close();
  console.log(`\n✅ Screenshots in ${OUT_DIR}`);
};

run().catch((e) => { console.error(e); process.exit(1); });
