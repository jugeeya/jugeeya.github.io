# Vendored ffmpeg.wasm loader

Byte-identical copies from the CDN (kept unmodified so they can be diffed
against upstream):

| file             | upstream                                                          |
| ---------------- | ----------------------------------------------------------------- |
| `ffmpeg.js`      | `@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js`                        |
| `814.ffmpeg.js`  | `@ffmpeg/ffmpeg@0.12.10/dist/umd/814.ffmpeg.js`                    |
| `ffmpeg-util.js` | `@ffmpeg/util@0.12.1/dist/umd/index.js`                            |

Both packages are MIT. Only the ~10 KB JS loader lives here — the ~32 MB
`@ffmpeg/core` (wasm) is still fetched from the CDN at runtime, so this costs
the repo almost nothing.

## Why these are vendored rather than loaded from the CDN

`ffmpeg.js` runs its actual work in a Web Worker, which it spawns from a
separate chunk (`814.ffmpeg.js`) resolved **relative to its own script URL**.
Loading `ffmpeg.js` from jsDelivr therefore tries to construct a Worker from a
cross-origin URL, which browsers refuse:

```
Failed to construct 'Worker': Script at
'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/umd/814.ffmpeg.js'
cannot be accessed from origin 'https://jugeeya.github.io'.
```

The usual `toBlobURL` workaround does **not** apply here: passing the library's
`classWorkerURL` option makes it spawn the worker with `{ type: "module" }`, but
this chunk calls `importScripts()` to pull in the core, and that is illegal
inside a module worker — so it swaps one failure for another.

Serving `ffmpeg.js` from our own origin fixes it properly: webpack's auto
`publicPath` resolves the chunk to `vods/vendor/814.ffmpeg.js` (same origin, so
the Worker is allowed), and it stays a *classic* worker, so its `importScripts`
call keeps working. Both files must sit side by side, and `814.ffmpeg.js` must
keep its exact filename — the loader computes it as `814` + `".ffmpeg.js"`.

The core is still passed in as a blob URL (`toBlobURL`), which is same-origin by
definition, so `importScripts` accepts it.

## Updating

Re-download all three at the same versions, keeping the filenames:

```sh
cd vods/vendor
curl -sS https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js     -o ffmpeg.js
curl -sS https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/umd/814.ffmpeg.js -o 814.ffmpeg.js
curl -sS https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/umd/index.js         -o ffmpeg-util.js
```

If a new `@ffmpeg/ffmpeg` release renames the worker chunk (the `814` is a
webpack chunk id), update the filename here to match, and keep `FF.core` in
`../vods.js` on a core version compatible with that release.
