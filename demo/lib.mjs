// Cinematic helpers for the Playwright demo: a fake cursor (headless Chromium
// doesn't render a real one), eased gliding, natural typing, title cards, and
// annotations. Inspired by https://justin.abrah.ms/blog/2026-02-12-generating-demo-videos-with-playwright.html

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Tracked cursor position (the demo drives a single page).
let pos = { x: 0, y: 0 };
export function resetCursor(x, y) { pos = { x, y }; }

// Inject the fake cursor + overlay styles. Runs on every navigation.
export async function installCinematics(page) {
  await page.addInitScript(() => {
    if (window.__cine) return;
    const css = `
      #__cursor{position:fixed;z-index:2147483647;width:22px;height:22px;margin:-11px 0 0 -11px;
        border-radius:50%;background:rgba(255,255,255,.95);
        box-shadow:0 0 0 2px rgba(0,0,0,.4),0 3px 10px rgba(0,0,0,.45);
        pointer-events:none;left:0;top:0;transition:transform .08s ease-out}
      #__cursor.click{transform:scale(.6)}
      .__ripple{position:fixed;z-index:2147483646;border:2px solid rgba(132,134,252,.95);border-radius:50%;
        pointer-events:none;width:8px;height:8px;margin:-4px 0 0 -4px;animation:__rip .55s ease-out forwards}
      @keyframes __rip{to{width:64px;height:64px;margin:-32px 0 0 -32px;opacity:0}}
      #__overlay{position:fixed;inset:0;z-index:2147483640;display:flex;align-items:center;justify-content:center;
        background:radial-gradient(circle at 50% 38%,#211b54,#0e0c24);color:#fff;text-align:center;
        font-family:'Poppins',system-ui,sans-serif;opacity:0;transition:opacity .6s ease}
      #__overlay .t{font-size:3.1rem;font-weight:700;margin:0 0 .6rem;letter-spacing:.01em}
      #__overlay .s{font-size:1.3rem;color:#bdb9ee;font-weight:300}
      .__note{position:fixed;z-index:2147483641;background:rgba(108,99,255,.97);color:#fff;
        padding:.55rem .85rem;border-radius:10px;font-family:'Poppins',system-ui,sans-serif;font-size:.98rem;
        line-height:1.25;box-shadow:0 8px 24px rgba(0,0,0,.45);opacity:0;transition:opacity .35s ease;max-width:340px}`;
    const style = document.createElement('style');
    style.textContent = css;
    document.documentElement.appendChild(style);
    // Match the page bg so zooming out leaves no white edges.
    document.documentElement.style.background = '#0e0c24';

    const cur = document.createElement('div');
    cur.id = '__cursor';
    document.documentElement.appendChild(cur);

    window.__cine = {
      move(x, y) { cur.style.left = x + 'px'; cur.style.top = y + 'px'; },
      click() {
        cur.classList.add('click');
        setTimeout(() => cur.classList.remove('click'), 130);
        const r = document.createElement('div');
        r.className = '__ripple';
        r.style.left = cur.style.left;
        r.style.top = cur.style.top;
        document.documentElement.appendChild(r);
        setTimeout(() => r.remove(), 580);
      },
    };
  });
}

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

// Glide the (real + fake) cursor to a point with easing.
export async function moveCursorTo(page, x, y, steps = 30) {
  const sx = pos.x, sy = pos.y;
  for (let i = 1; i <= steps; i++) {
    const t = easeOutCubic(i / steps);
    const cx = sx + (x - sx) * t;
    const cy = sy + (y - sy) * t;
    await page.mouse.move(cx, cy);
    await page.evaluate(([X, Y]) => window.__cine && window.__cine.move(X, Y), [cx, cy]);
    await sleep(11);
  }
  pos = { x, y };
}

async function centerOf(page, target) {
  // `target` may be a CSS selector string or a Playwright Locator.
  const loc = (typeof target === 'string' ? page.locator(target) : target).first();
  await loc.waitFor({ state: 'attached' });
  // Smooth-scroll into view only when it's near/over an edge, so deliberate
  // framing isn't yanked but off-screen targets still glide in smoothly.
  const offscreen = await loc.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const cy = r.top + r.height / 2;
    return cy < 90 || cy > window.innerHeight - 90;
  }).catch(() => true);
  if (offscreen) {
    await loc.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    await sleep(750);
  } else {
    await sleep(150);
  }
  const b = await loc.boundingBox();
  if (!b) throw new Error(`no bounding box for ${target}`);
  return { loc, x: b.x + b.width / 2, y: b.y + b.height / 2, box: b };
}

// Glide to an element and click it.
export async function glideAndClick(page, selector, { settle = 180 } = {}) {
  const { loc, x, y } = await centerOf(page, selector);
  await moveCursorTo(page, x, y);
  await page.evaluate(() => window.__cine && window.__cine.click());
  await sleep(settle);
  await loc.click();
}

// Glide to a field, focus it, and type the text one character at a time.
export async function glideAndType(page, selector, text, { perChar = 65, clear = true } = {}) {
  const { loc, x, y } = await centerOf(page, selector);
  await moveCursorTo(page, x, y);
  await page.evaluate(() => window.__cine && window.__cine.click());
  await loc.click();
  if (clear) await loc.fill('');
  for (const ch of text) {
    await page.keyboard.type(ch);
    await sleep(perChar + Math.random() * 45);
  }
}

// Full-screen title/outro card with fade in/out. Uses inline styles + a forced
// reflow so the fade-in reliably triggers (a bare rAF sometimes didn't).
// `stay: true` leaves it up (no fade-out) so the video can end on it.
export async function showTitleCard(page, title, subtitle = '', ms = 2600, { stay = false } = {}) {
  await page.evaluate(({ t, s }) => {
    let o = document.getElementById('__overlay');
    if (!o) { o = document.createElement('div'); o.id = '__overlay'; document.documentElement.appendChild(o); }
    o.style.cssText =
      'position:fixed;inset:0;z-index:2147483645;display:flex;align-items:center;justify-content:center;' +
      "background:radial-gradient(circle at 50% 38%,#211b54,#0e0c24);color:#fff;text-align:center;" +
      "font-family:'Space Grotesk','Inter',system-ui,sans-serif;opacity:0;transition:opacity .55s ease";
    o.innerHTML =
      `<div><div style="font-size:3.1rem;font-weight:700;margin:0 0 .6rem">${t}</div>` +
      `<div style="font-size:1.3rem;color:#bdb9ee;font-weight:300">${s}</div></div>`;
    void o.offsetWidth;       // force reflow so the opacity transition runs
    o.style.opacity = '1';
  }, { t: title, s: subtitle });
  await sleep(ms);
  if (stay) return;           // leave it up (e.g. final outro)
  await page.evaluate(() => {
    const o = document.getElementById('__overlay');
    if (o) { o.style.opacity = '0'; setTimeout(() => o.remove(), 650); }
  });
  await sleep(650);
}

// Smoothly scale the page (cinematic zoom). scale=1 clears the transform.
// Only used between interactions, so cursor/click coordinates stay accurate.
export async function setZoom(page, scale, ms = 0) {
  await page.evaluate(({ scale, ms }) => {
    const b = document.body;
    b.style.transformOrigin = 'top center';
    b.style.transition = ms ? `transform ${ms}ms cubic-bezier(.4,0,.2,1)` : 'none';
    b.style.transform = scale === 1 ? 'none' : `scale(${scale})`;
  }, { scale, ms });
  if (ms) await sleep(ms);
}

// Smooth-scroll an element into view and wait for it to settle.
export async function smoothScroll(page, target, block = 'center') {
  await page.evaluate(({ target, block }) => {
    const el = document.querySelector(target);
    if (el) el.scrollIntoView({ behavior: 'smooth', block });
  }, { target, block });
  await sleep(950);
}

// Floating label anchored above/below an element.
export async function showAnnotation(page, selector, text, { ms = 2200, place = 'top' } = {}) {
  const { box } = await centerOf(page, selector);
  await page.evaluate(({ box, text, place }) => {
    const n = document.createElement('div');
    n.className = '__note';
    n.textContent = text;
    document.documentElement.appendChild(n);
    const nb = n.getBoundingClientRect();
    let x = box.x + box.width / 2 - nb.width / 2;
    let y = place === 'top' ? box.y - nb.height - 14 : box.y + box.height + 14;
    x = Math.max(10, Math.min(x, window.innerWidth - nb.width - 10));
    y = Math.max(10, y);
    n.style.left = x + 'px';
    n.style.top = y + 'px';
    requestAnimationFrame(() => (n.style.opacity = '1'));
    window.__lastNote = n;
  }, { box, text, place });
  await sleep(ms);
  await page.evaluate(() => {
    const n = window.__lastNote;
    if (n) { n.style.opacity = '0'; setTimeout(() => n.remove(), 400); }
  });
}
