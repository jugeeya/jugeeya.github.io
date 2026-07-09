// Cinematic helpers for the Playwright demo: a fake cursor (headless Chromium
// doesn't render a real one), eased gliding, natural typing, title cards, and
// annotations. Inspired by https://justin.abrah.ms/blog/2026-02-12-generating-demo-videos-with-playwright.html

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// How long the fake cursor's CSS left/top transition takes (must match the
// `.34s` in the #__cursor rule below): callers wait this out so the dot has
// visibly arrived before the click fires.
const GLIDE_MS = 340;

// Tracked cursor position (kept for API compatibility; the cursor itself now
// follows real pointer events, so this is only a bookkeeping value).
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
      /* Opaque dark curtain over everything from the first paint until reveal.
         Not a title card (no text) -- just prevents the white browser default
         from flashing while the page loads + stages. revealPage fades it out. */
      #__curtain{position:fixed;inset:0;background:#141218;z-index:2147483640;
        opacity:1;transition:opacity .55s ease;pointer-events:none}
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

    const curtain = document.createElement('div');
    curtain.id = '__curtain';
    document.documentElement.appendChild(curtain);

    const cur = document.createElement('div');
    cur.id = '__cursor';
    // Start centred (still hidden) so the first reveal eases from mid-screen
    // rather than flying in from the top-left corner (0,0).
    cur.style.left = (window.innerWidth / 2) + 'px';
    cur.style.top = (window.innerHeight / 2) + 'px';
    document.documentElement.appendChild(cur);

    // Slave the fake cursor to the REAL pointer. Playwright's mouse actions
    // (hover / click / mouse.move) dispatch trusted mousemove events whose
    // clientX/clientY are the exact viewport point it is acting on, so binding
    // the cursor's left/top to those makes it correct *by construction* -- it
    // can no longer drift from where clicks actually land, whether the cause is
    // the zoom transform, a scroll, or a mid-animation layout shift. The CSS
    // transition on left/top turns each jump into a smooth glide. #__cursor is
    // fixed and lives on <html> (outside the scaled <body>), so clientX maps
    // straight to its left with no transform correction needed.
    window.addEventListener('mousemove', (e) => {
      cur.style.left = e.clientX + 'px';
      cur.style.top = e.clientY + 'px';
      cur.style.opacity = '1';
    }, true);
    // Ripple + press-shrink on the real mousedown, so click feedback fires
    // exactly when and where Playwright presses (including click()'s own
    // internal press) rather than at a separately-tracked guess.
    window.addEventListener('mousedown', () => {
      cur.classList.add('click');
      setTimeout(() => cur.classList.remove('click'), 130);
      const r = document.createElement('div');
      r.className = '__ripple';
      r.style.left = cur.style.left;
      r.style.top = cur.style.top;
      document.documentElement.appendChild(r);
      setTimeout(() => r.remove(), 580);
    }, true);

    window.__cine = {
      // Fade the cursor out for beats where the pointer isn't moving but the
      // page is (a scroll, or an annotation): a fixed cursor would otherwise
      // sit frozen mid-screen, appearing to point at whatever scrolled under
      // it. The next real mouse move fades it back in at the right spot.
      hide() { cur.style.opacity = '0'; },
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

// Glide the real pointer to a raw viewport point (the fake cursor follows via
// the mousemove listener). Rarely needed directly now that glideAndClick /
// glideAndType target elements through Playwright; kept for the odd free-form
// move.
export async function moveCursorTo(page, x, y, ms = GLIDE_MS) {
  await page.mouse.move(x, y, { steps: 6 });
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
    // The fake cursor is position:fixed and only moves when told to -- left
    // showing during a scroll, it stays at its old screen coordinates while
    // the page slides underneath it, visibly "pointing" at whatever content
    // now happens to be there. Hide it for the scroll; callers that go on to
    // moveCursorTo() (glideAndClick/glideAndType) fade it back in there.
    await page.evaluate(() => window.__cine && window.__cine.hide());
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

// Glide to an element and click it. Positioning is delegated entirely to
// Playwright: hover() moves the real pointer to the element's true, actionable
// centre -- auto-waiting for it to be visible AND stable (not mid-animation),
// which is exactly the guarantee the old measure-then-place approach lacked --
// and the fake cursor follows via the mousemove listener. We then wait out the
// visible glide before click() presses at that same spot.
export async function glideAndClick(page, selector, { settle = 110 } = {}) {
  const { loc } = await centerOf(page, selector);
  await loc.hover();
  await sleep(GLIDE_MS + settle);
  await loc.click();
}

// Glide to a field, focus it, and type the text one character at a time.
export async function glideAndType(page, selector, text, { perChar = 60, clear = true } = {}) {
  const { loc } = await centerOf(page, selector);
  await loc.hover();
  await sleep(GLIDE_MS);
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

// Reveal the fully-staged page: un-hide the body and fade the dark curtain
// out over it, so the tool appears with a clean fade rather than a pop (and
// never a white flash). Resolves once the fade has finished.
export async function revealPage(page) {
  await page.evaluate(() => {
    document.documentElement.classList.add('__lit');
    const c = document.getElementById('__curtain');
    if (c) { c.style.opacity = '0'; setTimeout(() => c.remove(), 600); }
  });
  await sleep(600);
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

// Floating caption pinned to a fixed corner of the frame -- not positioned
// relative to the target, so it never has to dodge its own edge-clamping and
// never covers the very thing it's describing. Still scrolls the target into
// view first (via centerOf) so viewers can see what's being discussed, then
// hides the fake cursor: this is a narration beat, not an interaction, and
// leaving the cursor at wherever it last was (now possibly scrolled past)
// would visibly point at the wrong thing for the whole caption duration.
export async function showAnnotation(page, selector, text, { ms = 2200 } = {}) {
  await centerOf(page, selector);
  await page.evaluate(() => window.__cine && window.__cine.hide());
  await page.evaluate((text) => {
    const n = document.createElement('div');
    n.className = '__note';
    n.textContent = text;
    document.documentElement.appendChild(n);
    n.style.top = '90px';
    n.style.right = '60px';
    requestAnimationFrame(() => (n.style.opacity = '1'));
    window.__lastNote = n;
  }, text);
  await sleep(ms);
  await page.evaluate(() => {
    const n = window.__lastNote;
    if (n) { n.style.opacity = '0'; setTimeout(() => n.remove(), 400); }
  });
}
