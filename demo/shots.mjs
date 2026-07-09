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

// A roomy single-column width (still below the 1024px two-column breakpoint):
// wide enough that @handles, diff arrows and the start.gg dropdown breathe, and
// the shots are meant to be clicked/enlarged anyway. Each shot is an element
// screenshot of a whole flow panel, so the viewport height only needs to be
// generous, not exact. 2x device scale keeps text crisp in the lightbox.
const W = 640, H = 1200, DSF = 2;
const BROKER = 'https://r2tag-broker.jdsambasivam.workers.dev';

// jugeeya's real start.gg avatar, embedded so the shot is deterministic offline.
// Committed directly (not under fixtures/, which is gitignored for the large
// generated .sav) since this is a small, deliberate asset the generator needs.
const JUGEEYA_AVATAR = 'data:image/jpeg;base64,' +
  readFileSync(fileURLToPath(new URL('./jugeeya-avatar.jpg', import.meta.url))).toString('base64');
// A generic silhouette for the fabricated second search result (no real
// person's photo stands in for a made-up account).
const SILHOUETTE_AVATAR = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
  '<rect width="64" height="64" fill="#3a3550"/>' +
  '<circle cx="32" cy="24" r="12" fill="#8b83a3"/>' +
  '<path d="M11 60c0-12 9.5-19 21-19s21 7 21 19z" fill="#8b83a3"/></svg>');

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

// Capture one flow panel as a self-contained card — an element screenshot grabs
// the whole panel (heading through its last step) regardless of viewport height,
// so shots never spill into the neighbouring section.
async function shootPanel(page, sel, name) {
  await sleep(250);
  await page.locator(sel).screenshot({ path: `${OUT_DIR}${name}.png` });
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

  // Deterministic start.gg (search + single-user lookup), the bracket lookup,
  // and a no-op submit. Both results answer the "jugeeya" query the shot types.
  const mockPlayers = [
    { slug: 'user/6192f6f1', gamerTag: 'jugeeya', prefix: '', image: JUGEEYA_AVATAR },
    { slug: 'user/jugz2', gamerTag: 'jugeeya_boogaloo', prefix: '', image: SILHOUETTE_AVATAR },
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
  // Screenshot-only tweaks: hide the hero gallery (so shots never show
  // themselves), and un-cap the browse list's inner scroll so every published
  // tag renders in the shot instead of hiding behind a 320px scroll area (lets
  // the install shot show plenty of unselected tags alongside the open diff).
  await page.addStyleTag({ content: `
    .demo-gallery, .demo-video { display: none !important; }
    #tagList { max-height: none !important; }
  ` });
  await page.locator('#tagBrowser .tag-list-item, #getFlow .tag-list-empty').first()
    .waitFor({ state: 'attached', timeout: 15000 }).catch(() => {});

  // ── Shot 1: Share flow — save loaded, a tag ticked, start.gg picker open ────
  {
    const input = page.locator('#savInput');
    await input.setInputFiles(SAVE_UPLOAD);
    await page.locator('#shareTagList .share-tag-checkbox').first().waitFor();
    // Prefer the JUGZ tag (matches the account we link below); fall back to the
    // first tag if the fixture doesn't have it.
    const jugz = page.locator('#shareTagList .share-tag-checkbox[value*="JUG" i]');
    const cb = (await jugz.count()) ? jugz.first() : page.locator('#shareTagList .share-tag-checkbox').first();
    await cb.check();
    const row = page.locator('#shareTagList .share-tag-item.is-selected');
    await row.locator('.sgg-input').waitFor({ timeout: 8000 });
    await row.locator('.sgg-input').fill('jugeeya');
    await row.locator('.sgg-result').first().waitFor({ timeout: 6000 }).catch(() => {});
    await shootPanel(page, '#shareFlow', 'share');
  }

  // ── Shot 2: Install flow — a tag selected with its "View changes" diff open,
  //      plenty of other (unselected) tags visible below it ────────────────────
  {
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
    }
    await shootPanel(page, '#getFlow', 'install');
  }

  await browser.close();
  console.log(`\n✅ Screenshots in ${OUT_DIR}`);
};

run().catch((e) => { console.error(e); process.exit(1); });
