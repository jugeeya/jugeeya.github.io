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

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
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

    const fileData = [];
    for (const f of files) {
      if (!f.name.toLowerCase().endsWith('.zip'))
        return json({ error: `${f.name}: must be a .zip` }, 400, cors);
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (bytes.length > MAX_ZIP_BYTES)
        return json({ error: `${f.name}: too large (max ${MAX_ZIP_BYTES} bytes)` }, 400, cors);
      if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) // "PK"
        return json({ error: `${f.name}: not a zip archive` }, 400, cors);
      fileData.push({ name: f.name, bytes });
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
    const stem = `${slugify(displayName)}-${rand()}`;
    slugs.push(stem);

    const zipBlob = await gh(env, api('/git/blobs'), {
      token,
      method: 'POST',
      body: { content: bytesToB64(f.bytes), encoding: 'base64' },
    });
    tree.push({ path: `tags/data/${stem}.r2tag.zip`, mode: '100644', type: 'blob', sha: zipBlob.sha });

    const sidecar = JSON.stringify(
      { name: displayName, author, file: `${stem}.r2tag.zip`, uploaded: now },
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

  const branch = `tag-submit/${slugs[0]}`;
  await gh(env, api('/git/refs'), {
    token,
    method: 'POST',
    body: { ref: `refs/heads/${branch}`, sha: commit.sha },
  });

  return gh(env, api('/pulls'), {
    token,
    method: 'POST',
    body: {
      title: `Tag submission${author ? ` from ${author}` : ''}`,
      head: branch,
      base,
      body: 'Automated tag submission from the website. Auto-merges if it passes validation.',
    },
  });
}

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
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
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
