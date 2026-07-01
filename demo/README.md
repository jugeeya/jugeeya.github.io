# Demo video recorder

Records a polished walkthrough of the Rivals II Controls / Tag Sharing tool with
Playwright — a fake cursor that glides with easing, natural typing, title cards,
and annotations — then you convert WebM → MP4 with ffmpeg.

Approach borrowed from
[Generating demo videos with Playwright](https://justin.abrah.ms/blog/2026-02-12-generating-demo-videos-with-playwright.html).

## Setup

```sh
cd demo
npm install
npx playwright install chromium     # one-time browser download
npm run fixture                     # builds fixtures/demo-save.sav from published tags
```

`npm run fixture` reuses the site's committed WASM to merge a few published tags
into a multi-tag save the demo can load. Alternatively, skip it and point at your
own save: `SAVE_FILE=/path/to/Rivals2_PlayerTagSaveSlot.sav`.

## Record

```sh
npm run record
# -> ✅ Recorded: videos/<hash>.webm  (+ a suggested ffmpeg command)
```

By default it drives the **live** site (`https://jugeeya.github.io/tags/`) so the
start.gg search and tag database are real. Two requests are mocked so the demo is
deterministic and harmless:

- the **bracket lookup** returns the currently-published tags as "entrants" (so
  they all get selected), and
- the **submit POST** is faked — *no real pull request is opened*.

Override the target with `TARGET=...`, but note a local copy can't reach the
broker/start.gg (CORS allows only the `jugeeya.github.io` origin), so the live
site is recommended.

## Convert to MP4 (+ optional music)

`-ss 0.5` trims the unavoidable blank first frame (the recording starts at page
creation, before anything can paint). `node demo.mjs` prints a ready-to-run line.

```sh
# basic
ffmpeg -ss 0.5 -i videos/<hash>.webm -vf "fps=30,scale=1280:720" -c:v libx264 -pix_fmt yuv420p -crf 20 demo.mp4

# with a music bed: fade in 2s, 15% volume, fade out over the last 3s
ffmpeg -ss 0.5 -i videos/<hash>.webm -i music.mp3 \
  -filter_complex "[1:a]afade=t=in:st=0:d=2,volume=0.15,afade=t=out:st=DURATION-3:d=3[a]" \
  -map 0:v -map "[a]" -shortest -c:v libx264 -pix_fmt yuv420p -crf 20 demo.mp4
```

(Replace `DURATION` with the video length in seconds.)

## Continuous recording (CI)

`.github/workflows/record-demo.yml` re-records the demo whenever the tool's
source changes (`index.html`, `styles.css`, `tags/*.{html,js,css}`,
`tags/wasm/**`, or `demo/*.mjs`). It serves the repo and records that local copy
(`TARGET=http://localhost:8000/tags/`), so the video reflects the just-pushed
code without waiting for a Pages deploy. When the target isn't the live site,
`demo.mjs` mocks the start.gg search/avatars so the recording stays deterministic
and offline (it also hides the page's own embedded video so the recording never
films itself).

To keep the multi-MB video out of git history, CI publishes `demo.mp4` and a
`demo-poster.jpg` as assets on a rolling **`demo` release**, at stable URLs:

```
https://github.com/jugeeya/jugeeya.github.io/releases/download/demo/demo.mp4
https://github.com/jugeeya/jugeeya.github.io/releases/download/demo/demo-poster.jpg
```

The tags page embeds those URLs (click-to-play).

## Tuning

- Pacing/typing speed: tweak `perChar`, `sleep(...)`, and annotation `ms` in
  `demo.mjs`; cursor easing/steps live in `lib.mjs`.
- Resolution: `W`/`H` and `deviceScaleFactor` in `demo.mjs` (2× gives crisp text).
- Add/remove scenes by editing the clearly-sectioned blocks in `demo.mjs`.
