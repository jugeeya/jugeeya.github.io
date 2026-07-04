// Cinematic helpers for the Playwright demo: a fake cursor (headless Chromium
// doesn't render a real one), eased gliding, natural typing, title cards, and
// annotations. Inspired by https://justin.abrah.ms/blog/2026-02-12-generating-demo-videos-with-playwright.html

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Tracked cursor position (the demo drives a single page).
let pos = { x: 0, y: 0 };
export function resetCursor(x, y) { pos = { x, y }; }

// Inject the fake cursor + overlay styles. Runs on every navigation.
//
// At document_start (when addInitScript runs) `document.documentElement` is still
// null, so we can't append yet — we watch for <html> via a MutationObserver and
// run setup the instant it's inserted, which is still before the body paints.
export async function installCinematics(page) {
  await page.addInitScript(() => {
    if (window.__cineInstalled) return;
    window.__cineInstalled = true;
    const setup = () => {
    if (window.__cine) return;
    const css = `
      /* Hide the page from its first paint so it never flashes before the intro.
         This is a class on <html> (not a child element), so the HTML parser can't
         drop it the way it drops a stray <div>. The demo adds .__lit to reveal. */
      html:not(.__lit) body{visibility:hidden !important}
      #__cursor{position:fixed;z-index:2147483647;width:22px;height:22px;margin:-11px 0 0 -11px;
        border-radius:50%;background:rgba(255,255,255,.95);
        box-shadow:0 0 0 2px rgba(0,0,0,.4),0 3px 10px rgba(0,0,0,.45);
        pointer-events:none;left:0;top:0;opacity:0;
        transition:left .34s cubic-bezier(.33,1,.68,1),top .34s cubic-bezier(.33,1,.68,1),transform .1s ease-out,opacity .3s ease}
      #__cursor.click{transform:scale(.6)}
      .__ripple{position:fixed;z-index:2147483646;border:2px solid rgba(143,211,232,.95);border-radius:50%;
        pointer-events:none;width:8px;height:8px;margin:-4px 0 0 -4px;animation:__rip .55s ease-out forwards}
      @keyframes __rip{to{width:64px;height:64px;margin:-32px 0 0 -32px;opacity:0}}
      #__overlay{position:fixed;inset:0;z-index:2147483640;display:flex;align-items:center;justify-content:center;
        background:radial-gradient(circle at 50% 38%,#0d3038,#08181c);color:#fff;text-align:center;
        font-family:'Space Grotesk','Poppins',system-ui,sans-serif;opacity:0;transition:opacity .6s ease}
      #__overlay .t{font-size:3.1rem;font-weight:700;margin:0 0 .6rem;letter-spacing:.01em}
      #__overlay .s{font-size:1.3rem;color:#a9d6e2;font-weight:300}
      .__note{position:fixed;z-index:2147483641;background:#8fd3e8;color:#06323b;
        padding:1.05rem 1.6rem;border-radius:16px;font-family:'Space Grotesk','Poppins',system-ui,sans-serif;
        font-size:2.15rem;font-weight:600;letter-spacing:-.01em;
        line-height:1.3;box-shadow:0 14px 40px rgba(0,0,0,.55);opacity:0;transition:opacity .35s ease;max-width:760px}`;
    const style = document.createElement('style');
    style.textContent = css;
    document.documentElement.appendChild(style);
    // Match the page bg so the hidden-body load and zoom-out leave no white edges.
    document.documentElement.style.background = '#141218';

    const cur = document.createElement('div');
    cur.id = '__cursor';
    document.documentElement.appendChild(cur);

    window.__cine = {
      move(x, y) { cur.style.left = x + 'px'; cur.style.top = y + 'px'; cur.style.opacity = '1'; },
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
    };
    if (document.documentElement) setup();
    else {
      const obs = new MutationObserver(() => {
        if (document.documentElement) { obs.disconnect(); setup(); }
      });
      obs.observe(document, { childList: true });
    }
  });
}

// Glide the cursor to a point. The fake cursor eases via a CSS transition (one
// round-trip, not 30); the real mouse moves for hover state.
export async function moveCursorTo(page, x, y, ms = 340) {
  await page.mouse.move(x, y, { steps: 6 });
  await page.evaluate(([X, Y]) => window.__cine && window.__cine.move(X, Y), [x, y]);
  await sleep(ms);
  pos = { x, y };
}

// Manually eased window scroll. Always animates (unlike scrollIntoView({smooth}),
// which becomes an instant jump under prefers-reduced-motion).
export async function smoothScrollToY(page, y, ms = 600) {
  await page.evaluate(({ y, ms }) => new Promise((res) => {
    const start = window.scrollY;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const dest = Math.max(0, Math.min(y, max));
    const dist = dest - start;
    if (Math.abs(dist) < 2) return res();
    const t0 = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 3);
    (function step(now) {
      const t = Math.min(1, (now - t0) / ms);
      window.scrollTo(0, start + dist * ease(t));
      t < 1 ? requestAnimationFrame(step) : res();
    })(performance.now());
  }), { y, ms });
}

// Smooth-scroll an element to the top (block 'start') or middle ('center').
export async function smoothScrollEl(page, selector, block = 'start', ms = 650) {
  const dest = await page.evaluate(({ selector, block }) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const top = window.scrollY + r.top;
    return block === 'center' ? top - (window.innerHeight - r.height) / 2 : top - 28;
  }, { selector, block });
  if (dest != null) await smoothScrollToY(page, dest, ms);
}

async function centerOf(page, target) {
  // `target` may be a CSS selector string or a Playwright Locator.
  const loc = (typeof target === 'string' ? page.locator(target) : target).first();
  await loc.waitFor({ state: 'attached' });
  let b = await loc.boundingBox();
  const vh = page.viewportSize().height;
  // Eased-scroll into view only when part of it is near/over an edge, so it's
  // fully visible before the click (Playwright won't then auto-scroll/jump).
  if (b && (b.y < 70 || b.y + b.height > vh - 70)) {
    const sy = await page.evaluate(() => window.scrollY);
    const dest = sy + b.y - Math.max(20, (vh - b.height) / 2);
    await smoothScrollToY(page, dest, 600);
    await sleep(120);
    b = await loc.boundingBox();
  } else {
    await sleep(120);
  }
  if (!b) throw new Error(`no bounding box for ${target}`);
  return { loc, x: b.x + b.width / 2, y: b.y + b.height / 2, box: b };
}

// Glide to an element and click it.
export async function glideAndClick(page, selector, { settle = 110 } = {}) {
  const { loc, x, y } = await centerOf(page, selector);
  await moveCursorTo(page, x, y);
  await page.evaluate(() => window.__cine && window.__cine.click());
  await sleep(settle);
  await loc.click();
}

// Glide to a field, focus it, and type the text one character at a time.
export async function glideAndType(page, selector, text, { perChar = 60, clear = true } = {}) {
  const { loc, x, y } = await centerOf(page, selector);
  await moveCursorTo(page, x, y);
  await page.evaluate(() => window.__cine && window.__cine.click());
  await loc.click();
  if (clear) await loc.fill('');
  await sleep(40);
  for (const ch of text) {
    await page.keyboard.type(ch);
    await sleep(perChar + Math.random() * 40);
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
      "background:radial-gradient(circle at 50% 38%,#0d3038,#08181c);color:#fff;text-align:center;" +
      "font-family:'Space Grotesk','Inter',system-ui,sans-serif;opacity:0;transition:opacity .55s ease";
    o.innerHTML =
      `<div><div style="font-size:3.1rem;font-weight:700;margin:0 0 .6rem">${t}</div>` +
      `<div style="font-size:1.3rem;color:#a9d6e2;font-weight:300">${s}</div></div>`;
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

// Reveal the page body (hidden from first paint by installCinematics' CSS).
// Call this while the title card still covers, so the reveal isn't visible.
export async function revealPage(page) {
  await page.evaluate(() => document.documentElement.classList.add('__lit'));
}

// Fade out the title overlay, revealing whatever is staged underneath (e.g. the
// zoomed-out overview). The page body must already be revealed via revealPage.
export async function hideTitleCard(page) {
  await page.evaluate(() => {
    const o = document.getElementById('__overlay');
    if (o) { o.style.opacity = '0'; setTimeout(() => o.remove(), 650); }
  });
  await sleep(650);
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
