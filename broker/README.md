# Tag submission broker

A small Cloudflare Worker that lets people submit `.r2tag.zip` tags from the
website **without a GitHub account**. It authenticates as a GitHub App and opens
a pull request; the repo's `validate-and-merge-tags` Action validates and
auto-merges it.

```
website form ──POST .r2tag.zip──▶ Worker (this) ──GitHub App──▶ PR
                                                                  │
                                              Action validates ◀──┘
                                              + auto-merges → tag goes live
```

## 1. Create the GitHub App

1. GitHub → **Settings → Developer settings → GitHub Apps → New GitHub App**.
2. Name it (e.g. `r2tag-broker`), set any homepage URL, **uncheck** "Webhook → Active".
3. **Repository permissions:**
   - **Contents: Read and write** (push the branch + commit)
   - **Pull requests: Read and write** (open the PR)
4. Create the app, then note the **App ID**.
5. **Generate a private key** — downloads a `.pem` (PKCS#1).
6. **Install** the app on the `jugeeya.github.io` repo only. After installing,
   the URL is `.../installations/<INSTALLATION_ID>` — note that number.

Convert the key to PKCS#8 (WebCrypto in the Worker requires it):

```sh
openssl pkcs8 -topk8 -nocrypt -in your-app.private-key.pem -out app-key-pkcs8.pem
```

## 2. Deploy the Worker

```sh
cd broker
npm i -g wrangler            # if needed
wrangler deploy

# Secrets (paste the PKCS#8 PEM, including BEGIN/END lines, for the key):
wrangler secret put GITHUB_APP_ID            # the App ID
wrangler secret put GITHUB_INSTALLATION_ID   # the installation id
wrangler secret put GITHUB_APP_PRIVATE_KEY   # contents of app-key-pkcs8.pem
```

Adjust `ALLOWED_ORIGIN` / `REPO_OWNER` / `REPO_NAME` / `BASE_BRANCH` in
`wrangler.toml` if needed.

## 3. Point the website at it

In `../tags/tags.js`, set:

```js
const UPLOAD_ENDPOINT = 'https://r2tag-broker.<your-subdomain>.workers.dev';
```

## start.gg proxy (GET /startgg/*)

Submitting requires linking a start.gg account, and tags can be downloaded by
bracket. The page can't call start.gg directly (its API sends no cross-origin
CORS headers), so this Worker proxies a few fixed, read-only lookups — never an
open GraphQL passthrough:

- `GET /startgg/search?q=<gamerTag>` → `{ players: [{ gamerTag, prefix, slug }] }`
- `GET /startgg/user?slug=user/<id>` → `{ slug, gamerTag, prefix }`
- `GET /startgg/event?slug=tournament/<t>/event/<e>` → `{ event, entrants: [{ entrant, gamerTag, slug }] }`

All use start.gg's unauthenticated website endpoint (no API token).

## How a submission flows

1. Visitor drops a `.r2tag.zip`, links a start.gg account, and submits → POST to
   this Worker (with `startgg_slug` / `startgg_tag`).
2. Worker checks size / extension / zip magic and that a valid `user/<id>` slug
   was supplied, then commits `tags/data/<slug>.r2tag.zip` +
   `tags/data/<slug>.json` (metadata, including `startgg`) on a new branch and
   opens a PR.
3. The Action re-validates authoritatively (path restriction, single real GVAS
   `.r2tag` inside the zip, size caps, sidecar shape), rebuilds
   `tags/data/index.json`, and squash-merges.
4. GitHub Pages redeploys; the tag shows up in the browse list.

To switch to **manual review**, just remove the "Auto-merge" step from
`.github/workflows/validate-and-merge-tags.yml` — PRs will queue for you instead.

## Notes & hardening

- The Worker holds the only write credential; the website ships no token.
- Validation never executes submitted content — it only parses the data files.
- Consider rate-limiting (Cloudflare WAF / a KV counter per IP) and a profanity
  check on the tag name; "benign" here covers structure/safety, not taste.
