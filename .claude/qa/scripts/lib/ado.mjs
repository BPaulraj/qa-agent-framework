// Azure DevOps REST client shared by ado.mjs and select-regression.mjs. Auth: PAT from env var.
import { fail } from './common.mjs';

export function createAdo(cfg, { requirePat = true } = {}) {
  const ado = cfg.ado || {};
  if (!ado.organization || !ado.project) fail('qa.config.json → ado.organization and ado.project are required.');
  const ORG = ado.organization.replace(/\/+$/, '');
  const PROJ = encodeURIComponent(ado.project);
  const PAT_VAR = ado.patEnvVar || 'AZURE_DEVOPS_EXT_PAT';
  const PAT = process.env[PAT_VAR];
  const V = 'api-version=7.1';

  async function request(method, url, body, contentType = 'application/json') {
    if (!PAT) {
      if (requirePat) fail(`Environment variable ${PAT_VAR} is not set. Create a PAT (Work Items + Test Management + Code, Read & Write) and export it.`);
      throw new Error(`${PAT_VAR} not set`);
    }
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: 'Basic ' + Buffer.from(':' + PAT).toString('base64'),
        'Content-Type': contentType,
        Accept: 'application/json',
      },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${url.replace(ORG, '')} → ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
    if (/<html/i.test(text.slice(0, 200))) throw new Error(`Got an HTML page from ${url}. PAT is probably invalid or expired.`);
    return { data: text ? JSON.parse(text) : {}, headers: res.headers };
  }

  const api = async (method, url, body, contentType) => (await request(method, url, body, contentType)).data;

  /** GET with continuation-token paging (testplan APIs). Returns the concatenated `value` arrays. */
  async function apiPaged(url) {
    const all = [];
    let token = null;
    do {
      const u = token ? `${url}${url.includes('?') ? '&' : '?'}continuationToken=${encodeURIComponent(token)}` : url;
      const { data, headers } = await request('GET', u);
      all.push(...(data.value || []));
      token = headers.get('x-ms-continuationtoken');
    } while (token);
    return all;
  }

  async function wiql(query) {
    const r = await api('POST', `${ORG}/${PROJ}/_apis/wit/wiql?${V}`, { query });
    return (r.workItems || []).map((w) => w.id);
  }

  /** Fetch work items in chunks of 200 (API limit), optionally with relations. */
  async function getWorkItems(ids, { relations = false } = {}) {
    const out = [];
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200).join(',');
      const r = await api('GET', `${ORG}/${PROJ}/_apis/wit/workitems?ids=${chunk}${relations ? '&$expand=relations' : ''}&errorPolicy=omit&${V}`);
      out.push(...(r.value || []).filter(Boolean));
    }
    return out;
  }

  /** Extract linked PRs and commits from work item relations (ArtifactLink vstfs URLs). */
  function gitLinks(relations = []) {
    const prs = [];
    const commits = [];
    for (const r of relations) {
      if (r.rel !== 'ArtifactLink' || !r.url?.startsWith('vstfs:///Git/')) continue;
      const [, kind, rest] = r.url.match(/^vstfs:\/\/\/Git\/([^/]+)\/(.+)$/) || [];
      const parts = decodeURIComponent(rest || '').split('/');
      if (kind === 'PullRequestId' && parts.length >= 3) prs.push({ repoId: parts[1], prId: Number(parts[2]) });
      if (kind === 'Commit' && parts.length >= 3) commits.push({ repoId: parts[1], commitId: parts[2] });
    }
    return { prs, commits };
  }

  const repoCache = new Map();
  /** Resolve a repo by name or id → { id, name }. */
  async function repo(nameOrId) {
    if (!repoCache.has(nameOrId)) {
      const r = await api('GET', `${ORG}/${PROJ}/_apis/git/repositories/${encodeURIComponent(nameOrId)}?${V}`);
      repoCache.set(nameOrId, { id: r.id, name: r.name });
    }
    return repoCache.get(nameOrId);
  }

  /** Files changed by a PR (latest iteration vs. target branch). Paths without leading slash. */
  async function prFiles(repoNameOrId, prId) {
    const { id } = await repo(repoNameOrId);
    const its = await api('GET', `${ORG}/${PROJ}/_apis/git/repositories/${id}/pullRequests/${prId}/iterations?${V}`);
    const last = (its.value || []).at(-1)?.id;
    if (!last) return [];
    const files = [];
    let skip = 0;
    for (;;) {
      const r = await api('GET', `${ORG}/${PROJ}/_apis/git/repositories/${id}/pullRequests/${prId}/iterations/${last}/changes?$top=1000&$skip=${skip}&$compareTo=0&${V}`);
      files.push(...(r.changeEntries || []).map((c) => c.item?.path).filter(Boolean));
      if (!r.nextSkip) break;
      skip = r.nextSkip;
    }
    return files.map((p) => p.replace(/^\//, ''));
  }

  /** Files changed by a commit. */
  async function commitFiles(repoNameOrId, commitId) {
    const { id } = await repo(repoNameOrId);
    const r = await api('GET', `${ORG}/${PROJ}/_apis/git/repositories/${id}/commits/${commitId}/changes?top=2000&${V}`);
    return (r.changes || []).filter((c) => c.item && !c.item.isFolder).map((c) => c.item.path.replace(/^\//, ''));
  }

  return { ado, ORG, PROJ, V, PAT, PAT_VAR, api, apiPaged, wiql, getWorkItems, gitLinks, repo, prFiles, commitFiles,
    wiUrl: (id) => `${ORG}/_apis/wit/workItems/${id}` };
}
