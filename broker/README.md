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

### Auto-deploy from CI (optional)

`.github/workflows/deploy-broker.yml` runs `wrangler deploy` on every change to
`broker/**` (and on manual dispatch). Add a `CLOUDFLARE_API_TOKEN` repo secret
(from the "Edit Cloudflare Workers" API-token template) to enable it — the job
self-skips until that secret exists. The Worker's own secrets (`GITHUB_APP_ID`,
`GITHUB_APP_PRIVATE_KEY`, `GITHUB_INSTALLATION_ID`) persist in Cloudflare across
deploys, so CI only needs the API token.

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
- `GET /startgg/event?phaseGroupId=<id>` → `{ event, section, entrants: [...] }` — only the
  entrants seeded into a single bracket section (phase group), e.g. when the page is given a
  `…/brackets/<phaseId>/<phaseGroupId>` URL. Smaller/faster than scanning the whole event.
- `GET /startgg/sets?slug=tournament/<t>/event/<e>` → completed sets with times/station (the VOD splitter).
- `GET /startgg/station?slug=…&station=<n>` → the not-yet-completed set currently at a station:
  `{ found, setId, state, fullRoundText, entrants: [{ id, name }] }`. Powers the MatchLogger
  console's "now playing" and the ingest pre-binding.

All use start.gg's unauthenticated website endpoint (no API token).

## MatchLogger aggregation (`/matchlogger/*`)

Stations running the [MatchLogger](../matchlogger/) mod + sender push their
results here; the operator [console](../matchlogger/) reads them back across
every station. Storage is a KV namespace where **each writer owns its own
keys** (`ml:cur:<slug>:<station>`, `ml:set:<slug>:<station>:<setId>`), so
concurrent stations never clobber each other (KV has no transactions).
Everything expires after 24h.

- `POST /matchlogger/current` `{ slug, station, current }` — a station's live
  heartbeat. On `current.state === "set_start"` the Worker looks up the
  station's start.gg entrants and caches them for pre-binding.
- `POST /matchlogger/ingest` `{ slug, station, set }` — a finished set. Matches
  it to the station's start.gg set, computes a candidate winner + confidence,
  stores it, and (if configured) posts a Discord notification. **Read-only with
  respect to the bracket.**
- `POST /matchlogger/live` `{ slug, station, set }` — a running (in-progress)
  set. Pushes the games-so-far to start.gg's **live** score via
  `markSetInProgress` + `updateBracketSet`, which records the per-game score +
  characters **without finalizing or advancing** the bracket. Station-side
  (station-key gated), players mapped to entrants by name; if they can't be
  mapped confidently it stores but skips the start.gg push (never publishes a
  guessed live score). Finalizing stays the operator's passcode-gated
  `/report`.
- `GET /matchlogger/event?slug=…` — the aggregated whole-event view the console
  renders: `{ slug, stations: {…}, sets: […] }`.
- `POST /matchlogger/report` `{ slug, station, setId, winnerEntrantId, passcode }`
  — report a matched set to start.gg. Sends per-game `gameData` (each game's
  winner + character selections, derived from the mod's logged games and mapped
  to start.gg character ids) so the full score is recorded; falls back to a
  winner-only report if any game can't be attributed. **Gated by an operator
  passcode** (see below).

Setup:

```sh
wrangler kv namespace create MATCHLOGGER   # paste the id into wrangler.toml
wrangler secret put DISCORD_WEBHOOK_URL     # optional: set-complete pings
wrangler secret put OPERATOR_KEY            # required to enable reporting (the passcode)
wrangler secret put STARTGG_TOKEN           # start.gg API token; enables the actual bracket write
wrangler secret put STATION_KEY             # optional: reject ingest/current without this key
```

### Why reporting is gated

The start.gg token authorizes Worker→start.gg, but the Worker URL is public, so
the *action* needs its own gate or anyone could POST `/matchlogger/report` and
write to your bracket (a "confused deputy"). So the operator supplies a
**passcode** (`OPERATOR_KEY`) with each report; the Worker checks it
(constant-time) before doing anything. Two-stage by design:

- `OPERATOR_KEY` unset → reporting disabled (503).
- Passcode wrong → 401.
- Passcode right but `STARTGG_TOKEN` unset → 501 (gate passes, the write isn't
  wired yet — so you can turn on the passcode UI before wiring the token).
- Both set → the winner is reported via start.gg's **authenticated** API
  (`api.start.gg/gql/alpha`), separate from the website API used for reads.

`STATION_KEY` is an optional, symmetric guard for `ingest`/`current`: if set, a
matching `key` must accompany those POSTs (the station sender's `--key`), which
stops strangers polluting your aggregated view. Left unset, those stay open
(low stakes — self-cleaning after 24h).

## How a submission flows

1. Visitor drops a `.r2tag.zip`, links a start.gg account, and submits → POST to
   this Worker (with `startgg_slug` / `startgg_tag`).
2. Worker checks size / extension / zip magic and that a valid `user/<id>` slug
   was supplied, then commits `tags/data/<slug>.r2tag.zip` +
   `tags/data/<slug>.json` (metadata, including `startgg`) on a new branch and
   opens a PR. The `<slug>` is deterministic per (tag name, start.gg user), so
   resubmitting the same tag is an **update**: it replaces the published pair in
   place instead of piling up duplicates. The Action only allows such a
   replacement when the sidecar's `startgg.slug` matches the published one — a
   submission can never overwrite another player's tag.
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
