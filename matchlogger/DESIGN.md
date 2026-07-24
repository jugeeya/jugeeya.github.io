# MatchLogger ↔ start.gg ↔ VOD splitter — integration design

This document describes how to connect the Rivals of Aether II **MatchLogger**
UE4SS mod (`ue4ss/Mods/MatchLogger/`) to a live tournament: knowing which
station a machine is, pinging when a set ends, optionally reporting the set to
start.gg, and feeding precise timings to the [VOD splitter](../vods/). Every
piece lives in this repo — the mod and per-station sender under `matchlogger/`,
the optional web console as a page here, and the broker endpoints in
[`../broker/worker.js`](../broker/worker.js).

## The core idea

Everything in the existing toolchain already joins on the same two coordinates:
**station number + wall-clock time**. The VOD splitter fetches sets from the
broker as `{ id, startedAt, completedAt, station, fullRoundText,
players:[{name, character}] }` and computes each clip as `startedAt −
recordingStart − pad`, filtered by station. start.gg is the source of
*identity* (who, which station, which round); the MatchLogger is the source of
*precise timing + characters + stats*. Tying them together just means giving
the MatchLogger the same two coordinates the rest of the system uses.

| Source          | Authoritative for                                          |
| --------------- | ---------------------------------------------------------- |
| **start.gg**    | set id, station, the two entrants, bracket round           |
| **MatchLogger** | frame-accurate set/match start & end, per-game characters, full stats (KOs, damage, parries, …) |
| **Join key**    | station + time window                                      |

## Components

At a real event every station needs to report, but nobody needs a dedicated
admin machine. So **every station PC runs the sender** (usually as the corner
widget, which is where its station number gets set), and the broker is the
**aggregation hub**. It streams each set's **per-game score and characters**
to start.gg live as the set is played — fully automatic, no human involved —
but **finalizing** a set (naming the winner, which advances the bracket) is
always an explicit human action: a click in the web console or Discord, never
triggered by ingest on its own. The hosted web console and Discord are
**optional views** on the broker's aggregated state — a debug console for
checking what the pipeline is doing, and the place that click happens — not
something the event depends on for the live-score part.

```mermaid
flowchart LR
    subgraph ST["Station PCs 1..N (each runs the sender widget)"]
        Game["Rivals 2 + UE4SS<br/>MatchLogger mod"]
        Files["MatchLogger/ JSON<br/>(per-set + current.json + live.json)"]
        Sender["Station sender<br/>(watch files → POST)"]
        Game -->|writes| Files
        Sender -->|watches| Files
    end
    Broker["r2tag-broker (Cloudflare Worker)<br/>aggregation store + start.gg token<br/>auto-pushes live score, never finalizes"]
    subgraph OPS["Optional operator views — all stations at once"]
        Console["Web console on jugeeya.github.io<br/>(debug view — any laptop / phone)"]
        Discord["Discord bot<br/>(confirm buttons + /report)"]
    end
    StartGG["start.gg API"]
    Splitter["VOD splitter (browser)"]

    Sender -->|"POST /matchlogger/live, /ingest (station N, shared key)"| Broker
    Broker <-->|"read + live score push"| StartGG
    Console <-->|"read sets · report winner"| Broker
    Discord <-->|"interactions"| Broker
    Broker -->|"/startgg/sets (existing)"| Splitter
```

The design keeps four concerns strictly separated:

- **The mod stays dumb and tournament-agnostic.** It writes JSON to disk and
  nothing else — no networking, no secrets, no station awareness. The same
  install works at any station.
- **The station sender is set-and-forget.** A tiny per-station background
  process that watches the MatchLogger folder and POSTs finished sets to the
  broker with its station number — this is what lets every station run with
  nobody sitting at it. Its station number is its only per-machine config,
  set (along with everything else) through the corner widget's Settings panel;
  the headless `station_sender.py` is the no-window variant.
- **The broker is the aggregation hub and holds the secrets.** It stores every
  ingested set per event (keyed by station + time), does the start.gg matching,
  and drives Discord. Note the current broker (`../broker/worker.js`) reads
  start.gg through its *unauthenticated website API* (`www.start.gg/api/-/gql`)
  — perfect for the read-only matching/lookup here, but a bracket **write**
  (`reportBracketSet`) needs authenticated access it does not yet have. See
  "Reporting to start.gg needs write access" below.
- **The operator surfaces are optional.** The bracket itself is administrated
  on start.gg, as at any event. Two interchangeable views read the broker's
  aggregated state when a human wants eyes on the pipeline: a **hosted web
  console** (effectively a debug view — is every station sending? did the set
  match?) and **Discord**. Ambiguous decisions (confirm a winner, fix an
  entrant mapping, push a report) happen on one of these — or the operator
  simply enters the result on start.gg directly and ignores them.

This is the same shape as the existing metrics project (mod → files → sender →
cloud) and the VOD splitter (browser → broker → start.gg).

## Data the mod already writes

`FinalizeSet()` in `main.lua` writes one file per set to `MatchLogger/sets/`:

```jsonc
{
  "setId": "20240115_143000",
  "complete": true,
  "startTime": "2024-01-15T14:30:00Z",       // character select entered
  "firstMatchStartTime": "2024-01-15T14:31:12Z",
  "endTime": "2024-01-15T14:43:05Z",
  "durationSeconds": 785,
  "winsRequired": 3,
  "matchCount": 4,
  "winnerSlot": 1, "winnerName": "…", "winnerCharacter": "clairen",
  "players": [ { "slot": 1, "name": "…", "character": "clairen", "wins": 3 }, … ],
  "matches": [ { "index": 1, "startTime": "…", "endTime": "…", "players": [ …full stats… ] }, … ]
}
```

### Mod additions needed

1. **Epoch timestamps.** The set report has ISO strings; the join with
   start.gg (`startedAt`/`completedAt` are epoch seconds) and with the VOD
   splitter is cleanest if the mod also emits `startEpoch` / `endEpoch`
   (`os.time()` is already computed internally). The sender could parse the
   `Z` ISO strings as UTC instead, but explicit epochs are less error-prone.

2. **A live-state file for "now playing".** To drive the UI's live station
   tracking — and, more importantly, to pre-bind entrant identity *before* a
   set ends — the mod overwrites a single `MatchLogger/current.json` at the
   hooks it already has:

   | Hook (existing)                | `current.json` becomes                              |
   | ------------------------------ | --------------------------------------------------- |
   | CharacterSelect → set start    | `{ "state": "set_start", "setId", "startEpoch" }`   |
   | VersusScreen → match start     | `{ "state": "match_start", "setId", "matchIndex" }` |
   | Results → match/set end         | `{ "state": "idle" }` (per-set file already written) |

   This is a small addition riding on hooks already in `main.lua`, and it is
   what makes identity matching reliable (see below).

## The station sender (headless, per station)

A tiny background process on each game PC — Python or Node, or an eventual
small `.exe`. It has no UI and no secrets; its only config is which station it
is (`--station 3`, or a one-line file). It:

- **Watches** `MatchLogger/sets/*.json` (new set) and `current.json` (live
  state).
- **On set start** (`current.json` → `set_start`): POSTs a lightweight
  heartbeat to `/matchlogger/current` so the broker (and thus the console)
  knows station N just started a set — this is what triggers the broker's
  `/startgg/station` pre-binding.
- **On a new set file:** stamps the station and POSTs it to
  `/matchlogger/ingest`, then marks the file consumed (same "clear after
  consume" pattern as the metrics project).

It retries on failure and is otherwise invisible. Every station PC runs one —
in practice as the corner widget (`station_widget.py`), the same sender with a
live status dot, a Settings panel that edits all of its config in place, and a
Log panel that replaces the terminal.

## The broker as aggregation hub

The broker stores, per event, every ingested set keyed by station + time, plus
the latest `current` heartbeat per station. That aggregated view is what the
console and Discord read, so a human can see all stations without anything
being co-located. Suggested shape (Cloudflare KV/R2/D1):

```jsonc
// GET /matchlogger/event?slug=…  → the operator's whole-event view
{
  "stations": {
    "3": { "current": { "state": "match_start", "setId": "…", "since": 170533… },
           "entrants": [ { "id": "…", "name": "…" }, … ] }   // pre-bound at set start
  },
  "sets": [
    { "id": "…", "station": 3, "ingestedAt": 170533…,
      "modSet": { …character/score/stats… },
      "matchedStartggSetId": "12345678",
      "candidateWinnerEntrantId": "…", "confidence": "high|low|none",
      "status": "recorded | matched | notified | reported | error" }
  ]
}
```

### Endpoints

Existing:

- `GET /startgg/sets?slug=…` → completed sets for the VOD splitter (unchanged).

New:

- `POST /matchlogger/current` → body `{ slug, station, key, current }`.
  Records the heartbeat; on a `set_start`, looks up `/startgg/station` and
  caches the entrants for pre-binding.
- `GET /startgg/station?slug=…&station=N` → the set called/in progress at
  station N: `{ setId, fullRoundText, state, entrants:[{id, name, seed}] }`.
- `POST /matchlogger/live` → body `{ slug, station, key, set }`. The one
  fully-automatic bracket write: pushes the games-so-far to start.gg via
  `markSetInProgress` + `updateBracketSet`, which never sets a winner and so
  can't advance the bracket. No human involved.
- `POST /matchlogger/ingest` → body `{ slug, station, key, set }`. Stores the
  finished set, matches it (station + time window, using the pre-bound
  entrants), and computes a candidate winner + confidence (see "Identity
  matching" below) purely to pre-fill the console's winner-picker and
  Discord's suggested button — it does **not** call `reportBracketSet` itself.
  Fires a Discord notification either way.
- `GET /matchlogger/event?slug=…` → the aggregated whole-event view above,
  for the web console (and an SSE variant for live updates).
- `POST /matchlogger/report` → body `{ slug, setId, winnerEntrantId, passcode
  }`. Calls start.gg's `reportBracketSet` mutation — the **only** path that
  ever finalizes a set, always an explicit human action regardless of how
  confident the ingest-time match was. Re-reporting an already-completed set
  (the console's **Switch winner**) resets it on start.gg first (`resetSet`)
  and reports again. **Requires start.gg write access (see below).**
- `POST /matchlogger/swap` → body `{ slug, station, setId, passcode }`.
  Toggles the set's player↔entrant mapping for when the station guessed the
  two identities backwards: subsequent live pushes (and the suggested winner)
  use the flipped mapping, and the corrected per-game score/characters are
  re-pushed to start.gg immediately.
- `POST /matchlogger/delete` → body `{ slug, station, setId, passcode }`.
  Removes one set record from the broker's aggregated view (duplicates,
  hand-warmers, test sets). Never touches start.gg: anything already reported
  there stays reported.
- `POST /discord/interactions` → Discord's interaction webhook: handles the
  confirm/report buttons and the manual `/report` slash command.

Discord credentials stay server-side in the Worker. `key` and `passcode` above
are the same shared secret — see "One shared key" below.

### Reporting to start.gg needs write access

The read endpoints (`/startgg/sets`, `/startgg/station`) work today because
the broker calls start.gg's unauthenticated website API. A bracket *write*
does not — `reportBracketSet` requires authentication. Two options:

- **Official start.gg API token** (developer token, added as a Worker secret).
  Clean and supported, but reporting requires the token's owner to have TO
  permissions on the event.
- **Logged-in session cookie** against the website API. No developer token,
  but fragile (expires, undocumented) — a fallback, not the primary path.

Until write access is wired up, every surface still does the full
notify/aggregate/confirm flow; the final "report" button is just disabled
(or falls back to "mark reported manually").

## Optional view 1 — the web console (a page in this repo)

A static page alongside `../vods/`, sharing `../styles.css` and the broker —
no local server, runs on any laptop or phone. It's the MatchLogger's **debug
view**: the event runs fine without it open, but when you want to check that
every station is sending, that heartbeats are flowing, or why a set didn't
match, this is where you look. It reads `/matchlogger/event` (SSE for live
updates) and shows:

- **Config:** event slug (broker URL is implicit).
- **Stations panel:** one live "now playing" card per station from the
  heartbeats — "Station 3: [A] vs [B] — Winners R2".
- **Sets-today table across all stations:** columns for station, time, players
  (character), score, matched start.gg round, and **status**. Every matched,
  not-yet-reported set exposes **Report**, which opens an inline winner picker
  (pre-selecting the confidence-based candidate when there is one) and calls
  `/matchlogger/report` with the shared key. Reporting is always this one
  explicit click — there is no set for which it happens on its own. Every
  matched, already-reported set exposes **Switch winner** instead (the same
  picker, the currently-reported winner marked), for when the confirmed
  auto-match turns out wrong — the broker resets the start.gg set and
  re-reports it. Unreported matched sets also expose **⇄ swap tags** for when
  the station guessed the two identities backwards — the mapping flips
  (characters and live score follow on start.gg immediately). And every row
  has a **✕ delete** (same passcode gate) that removes the set from this view
  only, for duplicates and hand-warmers; start.gg is never touched by a
  delete.

### One shared key, mandatory

The start.gg token lives only in the Worker, but a public Worker URL means
writing to the bracket needs its own gate or anyone could trigger it. That gate
is a single secret, `OPERATOR_KEY` — used both as the `key` every station
sender must send (mandatory; ingest/current/live all reject requests without
it) and as the `passcode` the console/Discord send for `/report`. There is
deliberately no separate, lower-stakes "station key" anymore.

This is a real tradeoff, made explicitly: `/matchlogger/live` — which every
station calls automatically, no human involved — pushes a real (if
non-advancing) write to start.gg, so the key every station PC's plaintext
config holds authorizes *some* bracket writes on its own, not just telemetry
submission. It does **not** let a station finalize a set by itself: `ingest`
never calls `reportBracketSet`, only `/matchlogger/report` does, and that's
always an explicit human action. The alternative — a station-only key with no
report-adjacent capability at all, separate from the console/Discord's
finalize credential — avoids even that smaller exposure and was the original
recommendation, but was decided against in favor of one key everywhere.

Everything still degrades cleanly: no `OPERATOR_KEY` configured → 503 on every
station endpoint *and* on `/report`; wrong key/passcode → 401; right key but
no `STARTGG_TOKEN` → live pushes are skipped (best-effort, doesn't fail the
station's call) and manual report returns 501. See
[`../broker/README.md`](../broker/README.md#one-shared-key-mandatory).

## Optional view 2 — Discord

Interchangeable with the web console, and often the more practical one since
TOs already live in Discord:

- **Notify + confirm inline.** On ingest the broker posts a message to a
  configured channel — "Station 3: set complete, 3–1, ~12 min, winner on
  Clairen → likely **[EntrantA]**" — with **Report 3–1** / **Swap winner** /
  **Ignore** buttons. Clicking Report calls the same `/matchlogger/report`
  path. Works from a phone, no software.
- **Manual `/report` slash command.** `/report station:3 score:3-1
  winner:@Player` — a fallback ingestion path for stations *not* running the
  mod, or for corrections. The broker resolves the station's set and writes
  it, so Discord doubles as a lightweight reporting UI for the whole event.

## Identity matching — the hard part, and the rule

To report a score you must map the game-set to a start.gg set **and its
winner**.

- **Which set?** Broker queries the event for the set called at station N near
  the reported time. Station + time window is usually unique — the same
  assumption the VOD splitter and TSH already rely on.
- **Which entrant won?** Fragile: in-game names (Steam/display) do not
  reliably equal start.gg tags, so exact-match is unreliable. Two fixes stack:
  **capture the two entrants at set start** (the sender's
  `/matchlogger/current` heartbeat triggers the broker's `/startgg/station`
  lookup), so by set end the pairing is known and the winner follows from
  side + score; and **translate save tags through the tag database** — the
  [tags page](../tags/) already publishes a save-tag → start.gg-tag mapping
  (`tags/data/index.json`) for every player who submitted controls, so the
  broker resolves each in-game name through it (cached in KV) before
  comparing against entrant names. This is what makes both the automatic
  live-score mapping and the ingest-time candidate winner land for anyone in
  the tag database; sponsor prefixes on entrant names ("TEAM | Tag") are
  stripped for the comparison too.

**Rule: notify + one-click confirm; never silently finalize.** `matchWinner()`
compares the set's declared winner name against the two pre-bound entrants and
returns one of:

- **`high`** — exact name match.
- **`low`** — fuzzy/partial match (one name contains the other).
- **`none`** — no overlap with either entrant at all.

This confidence only decides what the console's winner-picker pre-selects and
what Discord suggests in its button — it never decides whether a report
happens automatically, because none ever does. `/matchlogger/ingest` computes
the candidate and stops; the only thing that calls `reportBracketSet` is
`/matchlogger/report`, triggered by an explicit click regardless of
confidence. Reporting a wrong score to a live bracket is worse than not
reporting — it has to be manually corrected on start.gg afterward (a
`resetSet` + re-report) rather than just being caught before it landed — so
the system fails toward pinging a human every time, not just for the
low/no-confidence cases.

Note this is narrower than what `/matchlogger/live` already does
automatically: it streams the *running* per-game score and characters to
start.gg with no human involved, because `updateBracketSet` never sets a
winner and so can't advance the bracket on its own. Only the winner-setting
action is gated behind a human click.

## VOD splitter tie-in

start.gg's `startedAt`/`completedAt` are report/call times (loose). The
MatchLogger's are frame-accurate. Two low-cost wins:

- **Timing export:** because the broker already holds every ingested set, it
  can serve a `sets[]` array in the exact shape the splitter consumes (`{
  startedAt, completedAt, station, fullRoundText, players:[{name, character}]
  }`) but with MatchLogger timestamps — tighter clips, auto-named by merging
  start.gg round text with MatchLogger characters. The splitter just points at
  a `/matchlogger/sets` endpoint instead of `/startgg/sets`.
- **Filename station stamp:** putting the station in the OBS recording
  filename (`Station5_2024-01-15 14-30-00.mkv`) lets the mod, the sender, and
  the splitter agree on station with no extra config, and the splitter can
  auto-select the station from the filename it already parses.

## Where each piece lives

Everything is in this one repo (`jugeeya.github.io`):

- **`matchlogger/ue4ss/`** — the UE4SS mod + minimal profile (drop-in install
  for a game PC).
- **`matchlogger/sender/`** — the per-station sender ✅ *(built:
  `station_sender.py` (headless) + `station_widget.py`/`rivals-station-reporter.pyw`
  (the corner-widget GUI every station actually runs), stdlib-only, forwards
  `sets/*.json`, `current.json`, and `live.json` to the broker with the
  station stamped on and the shared key attached)*.
- **`matchlogger/` page** (`index.html` + `matchlogger.js/.css`) — the optional
  web console, a static page alongside `../vods/` sharing `../styles.css` ✅
  *(built: live "now playing" per station + a sets-today table; reads
  `/matchlogger/event`; Report button + winner picker on every matched set)*.
- **`../broker/worker.js`** — the `/matchlogger/*` endpoints (ingest matches
  but never finalizes; `/live` auto-pushes non-advancing score; `/report` is
  the only finalize path) and `/startgg/station` + KV aggregation store ✅
  *(built; Discord notify optional via `DISCORD_WEBHOOK_URL`)*. Live and
  validated against a real start.gg bracket, `STARTGG_TOKEN` + `OPERATOR_KEY`
  both configured.
- **`matchlogger/DESIGN.md`** — this document.

## Phasing

- **Phase 0 — sender + console skeleton.** ✅ Done.
- **Phase 1 — ingest + Discord notify.** ✅ Done.
- **Phase 2 — live tracking + report.** ✅ Done: `current.json`/`live.json` mod
  output, `/startgg/station` pre-binding, per-game `gameData` (score +
  characters), the console's winner picker, live (non-advancing) score pushes.
- **Phase 3 — guarded auto-report.** Deliberately **not** done: finalizing a
  set always stays a manual click (console/Discord), at any confidence level
  — see "Identity matching" above. What *is* automatic and already built is
  the live per-game score/character push (`/matchlogger/live`), which can't
  advance the bracket by construction. Still to do: the Discord `/report`
  slash command, and the `/matchlogger/sets` timing export for the VOD
  splitter.

## Operational notes

- start.gg write credentials and Discord credentials live only in the broker;
  the read path uses start.gg's unauthenticated website API.
- **Live per-game score/characters push automatically; finalizing never
  does.** `/matchlogger/live` needs no human. Naming a winner — the write that
  advances the bracket — always goes through the console/Discord's explicit
  Report action, regardless of match confidence.
- Every station PC runs the sender (widget); none of them needs an operator
  sitting at it. A station that isn't running the mod at all can still be
  reported via the Discord `/report` command — or simply on start.gg, as
  always.
- The anti-cheat/offline caveat from the mod README still applies — UE4SS only
  injects when the game runs without Easy Anti-Cheat.
