# Hero screenshots

Generates the clickable screenshot gallery shown in the tags page hero
(`tags/shots/*.png`) by driving the real UI with Playwright and capturing the
viewport at a phone-ish width, 3× scale, for retina-crisp stills.

(This used to record a walkthrough video; a few crisp screenshots proved far
more reliable and read better as a hero, so the video was retired.)

## Setup

```sh
cd demo
npm install
npx playwright install chromium     # one-time browser download
npm run fixture                     # builds fixtures/demo-save.sav from published tags
```

`npm run fixture` reuses the site's committed WASM to merge a few published tags
into a multi-tag save the screenshots can load. Alternatively, skip it and point
at your own save: `SAVE_FILE=/path/to/Rivals2_PlayerTagSaveSlot.sav`.

## Generate

```sh
npm run shots
# -> ✅ Screenshots in ../tags/shots/
```

By default it drives the **live** site (`https://jugeeya.github.io/tags/`) so the
start.gg lookup and tag database are real. Everything with side effects is
mocked so it's deterministic and harmless:

- **start.gg** search / user lookup return a fixed player (with an inline avatar),
- the **bracket lookup** and **submit POST** are faked — *no real pull request is
  opened*.

Override the target with `TARGET=http://localhost:8848/tags/` to shoot a local
copy (mocks make this work fully offline).

## Automation

`.github/workflows/screenshots.yml` regenerates and commits the screenshots when
the generator (`demo/shots.mjs`) or the tags UI (`tags/index.html`, `tags.css`,
`tags.js`) changes, and on manual dispatch — so the gallery never drifts out of
sync with the live UI.
