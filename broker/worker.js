// Tag submission broker (Cloudflare Worker).
//
// Receives a multipart POST of one or more `.r2tag.zip` files (+ an optional
// author), does light validation, then authenticates as a GitHub App and opens
// a pull request on the repo adding each tag's zip and a metadata sidecar. The
// repo's "Validate and merge tag submissions" Action does the authoritative
// checks and auto-merges.
//
// Required secrets (wrangler secret put ...):
//   GITHUB_APP_ID            - the App's numeric id
//   GITHUB_APP_PRIVATE_KEY   - the App private key in PKCS#8 PEM
//                              (convert the downloaded key:
//                               openssl pkcs8 -topk8 -nocrypt -in key.pem)
//   GITHUB_INSTALLATION_ID   - the installation id on the target repo
// Vars (wrangler.toml): ALLOWED_ORIGIN, REPO_OWNER, REPO_NAME, BASE_BRANCH

const MAX_ZIP_BYTES = 512 * 1024;
const MAX_FILES = 10;

// start.gg's website API — unauthenticated, same endpoint the site itself uses.
const STARTGG_API = 'https://www.start.gg/api/-/gql';
const STARTGG_HEADERS = {
  'Content-Type': 'application/json',
  'client-version': '20',
  'User-Agent':
    'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36',
};
const SLUG_RE = /^user\/[a-z0-9]+$/i;

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(request.url);

    // start.gg lookups are proxied here so the page can query them despite the
    // start.gg API not sending cross-origin CORS headers. Only a few fixed,
    // read-only operations are exposed — never an open GraphQL passthrough.
    if (request.method === 'GET' && url.pathname.startsWith('/startgg/')) {
      return handleStartgg(env, url, cors);
    }

    if (request.method !== 'POST') return json({ error: 'POST only' }, 405, cors);

    let form;
    try {
      form = await request.formData();
    } catch {
      return json({ error: 'Expected multipart/form-data' }, 400, cors);
    }

    const author = (form.get('author') || '').toString().trim().slice(0, 64);

    const files = form.getAll('tags').filter(f => typeof f === 'object' && f.name);
    if (!files.length) return json({ error: 'No files provided.' }, 400, cors);
    if (files.length > MAX_FILES) return json({ error: `Too many files (max ${MAX_FILES}).` }, 400, cors);

    // start.gg links may be given once (applies to every file — the website's
    // case) or once per file in order (the desktop tool's per-tag case).
    const rawSlugs = form.getAll('startgg_slug').map(s => s.toString().trim().slice(0, 64));
    const rawTags = form.getAll('startgg_tag').map(s => s.toString().trim().slice(0, 64));
    let startggList;
    if (rawSlugs.length === 1) {
      startggList = files.map(() => ({ slug: rawSlugs[0], tag: rawTags[0] || '' }));
    } else if (rawSlugs.length === files.length) {
      startggList = files.map((_, i) => ({ slug: rawSlugs[i], tag: rawTags[i] || '' }));
    } else {
      return json({ error: 'startgg_slug must be given once or once per file.' }, 400, cors);
    }
    for (const s of startggList) {
      if (!SLUG_RE.test(s.slug))
        return json({ error: 'A start.gg user must be linked (e.g. user/6192f6f1).' }, 400, cors);
    }

    const fileData = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (!f.name.toLowerCase().endsWith('.zip'))
        return json({ error: `${f.name}: must be a .zip` }, 400, cors);
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (bytes.length > MAX_ZIP_BYTES)
        return json({ error: `${f.name}: too large (max ${MAX_ZIP_BYTES} bytes)` }, 400, cors);
      if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) // "PK"
        return json({ error: `${f.name}: not a zip archive` }, 400, cors);
      fileData.push({ name: f.name, bytes, startgg: startggList[i] });
    }

    try {
      const token = await getInstallationToken(env);
      const pr = await openPullRequest(env, token, fileData, author);
      return json({ ok: true, pr: pr.html_url, number: pr.number }, 200, cors);
    } catch (err) {
      return json({ error: `Could not open PR: ${err.message}` }, 502, cors);
    }
  },
};

// ---- start.gg proxy -------------------------------------------------------

async function handleStartgg(env, url, cors) {
  const op = url.pathname.slice('/startgg/'.length);
  try {
    if (op === 'search') {
      const q = (url.searchParams.get('q') || '').trim().slice(0, 64);
      if (q.length < 2) return json({ players: [], page: 1, totalPages: 1 }, 200, cors);
      const page = Math.min(100, Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1));
      const data = await startggGql(
        `query($q:String!,$page:Int!){ players(query:{ perPage:30, page:$page, filter:{ gamerTag:$q } }){
           pageInfo{ totalPages }
           nodes{ gamerTag prefix user{ slug images(type:"profile"){ url } } } } }`,
        { q, page }
      );
      const seen = new Set();
      const players = ((data.players && data.players.nodes) || [])
        .filter(n => n.user && n.user.slug)
        .map(n => ({
          gamerTag: n.gamerTag || '',
          prefix: n.prefix || '',
          slug: n.user.slug,
          image: ((n.user.images || [])[0] || {}).url || '',
        }))
        .filter(p => (seen.has(p.slug) ? false : seen.add(p.slug)));
      const totalPages = (data.players && data.players.pageInfo && data.players.pageInfo.totalPages) || page;
      return json({ players, page, totalPages }, 200, cors);
    }

    if (op === 'user') {
      const slug = (url.searchParams.get('slug') || '').trim();
      if (!SLUG_RE.test(slug)) return json({ error: 'Bad user slug.' }, 400, cors);
      const data = await startggGql(
        `query($slug:String!){ user(slug:$slug){ slug player{ gamerTag prefix } } }`,
        { slug }
      );
      const u = data.user;
      if (!u) return json({ error: 'User not found.' }, 404, cors);
      return json({
        slug: u.slug,
        gamerTag: (u.player && u.player.gamerTag) || '',
        prefix: (u.player && u.player.prefix) || '',
      }, 200, cors);
    }

    if (op === 'event') {
      const phaseGroupId = (url.searchParams.get('phaseGroupId') || '').trim();

      // A single bracket section (start.gg phase group): only that section's
      // entrants are fetched — far smaller than paging the whole event.
      if (phaseGroupId) {
        if (!/^\d{1,15}$/.test(phaseGroupId))
          return json({ error: 'Bad phase group id.' }, 400, cors);
        const entrants = [];
        let page = 1, totalPages = 1, eventName = '', section = '';
        do {
          const data = await startggGql(
            `query($id:ID!,$page:Int!){ phaseGroup(id:$id){ displayIdentifier
               phase{ name event{ name } }
               seeds(query:{ page:$page, perPage:64 }){
                 pageInfo{ totalPages }
                 nodes{ entrant{ name participants{ gamerTag user{ slug } } } } } } }`,
            { id: phaseGroupId, page }
          );
          const pg = data.phaseGroup;
          if (!pg) return json({ error: 'Bracket section not found.' }, 404, cors);
          const c = pg.seeds || {};
          totalPages = (c.pageInfo && c.pageInfo.totalPages) || 1;
          for (const s of c.nodes || []) {
            const ent = s.entrant;
            if (!ent) continue;
            for (const p of ent.participants || []) {
              if (p.user && p.user.slug)
                entrants.push({ entrant: ent.name || '', gamerTag: p.gamerTag || '', slug: p.user.slug });
            }
          }
          if (page === 1) {
            eventName = (pg.phase && pg.phase.event && pg.phase.event.name) || '';
            // e.g. "Pool Play (A)" or just "Top 64" — skip a lone "1" group id.
            const ident = pg.displayIdentifier && pg.displayIdentifier !== '1'
              ? `(${pg.displayIdentifier})` : '';
            section = [pg.phase && pg.phase.name, ident].filter(Boolean).join(' ');
          }
          page++;
        } while (page <= totalPages && page <= 30);
        return json({ event: eventName, section, entrants }, 200, cors);
      }

      const slug = (url.searchParams.get('slug') || '').trim().slice(0, 200);
      if (!/^tournament\/[^/]+\/event\/[^/]+$/i.test(slug))
        return json({ error: 'Expected an event slug like tournament/<t>/event/<e>.' }, 400, cors);
      const entrants = [];
      let page = 1, totalPages = 1;
      do {
        const data = await startggGql(
          `query($slug:String!,$page:Int!){ event(slug:$slug){ name
             entrants(query:{ page:$page, perPage:64 }){
               pageInfo{ totalPages }
               nodes{ name participants{ gamerTag user{ slug } } } } } }`,
          { slug, page }
        );
        const ev = data.event;
        if (!ev) return json({ error: 'Event not found.' }, 404, cors);
        const c = ev.entrants || {};
        totalPages = (c.pageInfo && c.pageInfo.totalPages) || 1;
        for (const n of c.nodes || []) {
          for (const p of n.participants || []) {
            if (p.user && p.user.slug)
              entrants.push({ entrant: n.name || '', gamerTag: p.gamerTag || '', slug: p.user.slug });
          }
        }
        if (page === 1) var eventName = ev.name || '';
        page++;
      } while (page <= totalPages && page <= 30); // safety cap (~1900 entrants)
      return json({ event: eventName, entrants }, 200, cors);
    }

    if (op === 'sets') {
      // Completed sets for an event, with their start/end times and station —
      // used by the VOD splitter to compute per-set clip boundaries.
      const slug = (url.searchParams.get('slug') || '').trim().slice(0, 200);
      if (!/^tournament\/[^/]+\/event\/[^/]+$/i.test(slug))
        return json({ error: 'Expected an event slug like tournament/<t>/event/<e>.' }, 400, cors);
      const setsOut = [];
      let page = 1, totalPages = 1, eventName = '';
      do {
        const data = await startggGql(
          `query($slug:String!,$page:Int!){ event(slug:$slug){ name
             sets(page:$page, perPage:50, sortType:STANDARD, filters:{ state:[3] }){
               pageInfo{ totalPages }
               nodes{ id startedAt completedAt fullRoundText
                 station{ number } slots{ entrant{ name } } } } } }`,
          { slug, page }
        );
        const ev = data.event;
        if (!ev) return json({ error: 'Event not found.' }, 404, cors);
        const c = ev.sets || {};
        totalPages = (c.pageInfo && c.pageInfo.totalPages) || 1;
        for (const n of c.nodes || []) {
          if (!n.startedAt || !n.completedAt) continue;
          const names = (n.slots || [])
            .map((s) => s.entrant && s.entrant.name).filter(Boolean);
          const label = [n.fullRoundText, names.join(' vs ')].filter(Boolean).join(': ');
          setsOut.push({
            id: n.id,
            startedAt: n.startedAt,
            completedAt: n.completedAt,
            station: n.station ? n.station.number : null,
            name: label || `Set ${n.id}`,
          });
        }
        if (page === 1) eventName = ev.name || '';
        page++;
      } while (page <= totalPages && page <= 40); // safety cap
      return json({ event: eventName, sets: setsOut }, 200, cors);
    }

    return json({ error: 'Unknown start.gg operation.' }, 404, cors);
  } catch (err) {
    return json({ error: `start.gg lookup failed: ${err.message}` }, 502, cors);
  }
}

async function startggGql(query, variables) {
  const res = await fetch(STARTGG_API, {
    method: 'POST',
    headers: STARTGG_HEADERS,
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`start.gg ${res.status}`);
  const out = await res.json();
  if (out.errors && out.errors.length) throw new Error('GraphQL error');
  return out.data || {};
}

// ---- GitHub App auth ------------------------------------------------------

async function getInstallationToken(env) {
  const jwt = await appJwt(env);
  const res = await gh(env, `/app/installations/${env.GITHUB_INSTALLATION_ID}/access_tokens`, {
    method: 'POST',
    token: jwt,
  });
  return res.token;
}

async function appJwt(env) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iat: now - 60, exp: now + 540, iss: env.GITHUB_APP_ID };
  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const signingInput = `${enc(header)}.${enc(payload)}`;

  const key = await importPrivateKey(env.GITHUB_APP_PRIVATE_KEY);
  const sig = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

async function importPrivateKey(pem) {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    der.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

// ---- Open the PR via the Git Data API -------------------------------------

async function openPullRequest(env, token, fileData, author) {
  const owner = env.REPO_OWNER;
  const repo = env.REPO_NAME;
  const base = env.BASE_BRANCH || 'main';
  const api = (p) => `/repos/${owner}/${repo}${p}`;

  const ref = await gh(env, api(`/git/ref/heads/${base}`), { token });
  const baseSha = ref.object.sha;
  const baseCommit = await gh(env, api(`/git/commits/${baseSha}`), { token });
  const baseTreeSha = baseCommit.tree.sha;

  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const tree = [];
  const slugs = [];

  for (const f of fileData) {
    const displayName = f.name.replace(/(\.r2tag)?\.zip$/i, '');
    // Deterministic per (tag name, start.gg user) so a re-upload of the same tag
    // by the same person lands on the same path and replaces it, rather than
    // piling up duplicates the way a random suffix did.
    const startggId = (f.startgg.slug || '').replace(/^user\//i, '');
    const stem = `${slugify(displayName)}-${startggId}`;
    slugs.push(stem);

    const zipBlob = await gh(env, api('/git/blobs'), {
      token,
      method: 'POST',
      body: { content: bytesToB64(f.bytes), encoding: 'base64' },
    });
    tree.push({ path: `tags/data/${stem}.r2tag.zip`, mode: '100644', type: 'blob', sha: zipBlob.sha });

    const sidecar = JSON.stringify(
      {
        name: displayName,
        author,
        file: `${stem}.r2tag.zip`,
        uploaded: now,
        startgg: { slug: f.startgg.slug, tag: f.startgg.tag || '' },
      },
      null, 2
    ) + '\n';
    const sideBlob = await gh(env, api('/git/blobs'), {
      token,
      method: 'POST',
      body: { content: sidecar, encoding: 'utf-8' },
    });
    tree.push({ path: `tags/data/${stem}.json`, mode: '100644', type: 'blob', sha: sideBlob.sha });
  }

  const newTree = await gh(env, api('/git/trees'), {
    token,
    method: 'POST',
    body: { base_tree: baseTreeSha, tree },
  });

  const commit = await gh(env, api('/git/commits'), {
    token,
    method: 'POST',
    body: {
      message: `Add tag submission${fileData.length > 1 ? 's' : ''}`,
      tree: newTree.sha,
      parents: [baseSha],
    },
  });

  // File paths are deterministic, but the branch keeps a random suffix so a
  // re-upload doesn't collide with a stale/pending branch of the same name.
  const branch = `tag-submit/${slugs[0]}-${rand()}`;
  await gh(env, api('/git/refs'), {
    token,
    method: 'POST',
    body: { ref: `refs/heads/${branch}`, sha: commit.sha },
  });

  const prBody = {
    title: `Tag submission${author ? ` from ${author}` : ''}`,
    head: branch,
    base,
    body: 'Automated tag submission from the website. Auto-merges if it passes validation.',
  };
  try {
    return await gh(env, api('/pulls'), { token, method: 'POST', body: prBody });
  } catch (err) {
    // GitHub's POST /pulls sometimes returns 504/502 even though the PR was
    // actually created — the write lands but the response times out (PR creation
    // is heavy). Reporting that as a failure is a false negative (the user saw
    // "Submission failed" for a PR that opened and merged). The branch is unique,
    // so check whether a PR now exists on it and return that instead.
    for (let attempt = 0; attempt < 3; attempt++) {
      await sleep(1000);
      const existing = await gh(
        env, api(`/pulls?head=${owner}:${branch}&state=all&per_page=1`), { token }
      ).catch(() => null);
      if (Array.isArray(existing) && existing.length) return existing[0];
    }
    throw err;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- Small helpers --------------------------------------------------------

async function gh(env, path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'r2tag-broker',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`GitHub ${method} ${path} -> ${res.status} ${await res.text()}`);
  }
  return res.json();
}

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function b64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bytesToB64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function slugify(s) {
  return (
    s.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'tag'
  );
}

function rand() {
  return Math.random().toString(36).slice(2, 8);
}
