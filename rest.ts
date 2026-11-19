// rest.ts — GitHub REST v3 under /api/v3: repositories, branches, commits, contents,
// issues, comments, labels and pull requests, over the in-memory store.
// Shapes follow api.github.com closely enough for the suite's shape checks; every reply is
// JSON, carries X-GitHub-Request-Id (added by the router), and errors carry a string message.

import { parseCommit, storeObject, type ObjectMap } from './git.ts';
import { isRecord, sendJson, sendNoContent, type parseJsonBody } from './http.ts';
import { Store, VIEWER, type Issue, type Pull, type Repo } from './store.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface RestCtx {
  req: IncomingMessage;
  res: ServerResponse;
  store: Store;
  method: string;
  path: string; // pathname, decoded, no trailing slash (except root '/')
  query: URLSearchParams;
  body: unknown; // parsed JSON body, or null when malformed (caller already answered 400)
  bodyRaw: Buffer;
  requestId: string;
  host: string; // Host header value, for absolute Link URLs
}

type Body = ReturnType<typeof parseJsonBody>;

function err(ctx: RestCtx, status: number, message: string): void {
  sendJson(ctx.res, status, { message }, { 'x-github-request-id': ctx.requestId });
}

function ok(ctx: RestCtx, status: number, body: unknown, extra: Record<string, string> = {}): void {
  sendJson(ctx.res, status, body, { 'x-github-request-id': ctx.requestId, ...extra });
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: VIEWER.id, node_id: VIEWER.node_id, type: 'User', avatar_url: '' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    html_url: `https://github.com/${repo.fullName}`,
    clone_url: `https://github.com/${repo.fullName}.git`,
    git_url: `git://github.com/${repo.fullName}.git`,
    ssh_url: `git@github.com:${repo.fullName}.git`,
    homepage: '',
    language: null,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    license: null,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

function labelJson(label: { name: string; color: string; description: string }): Record<string, unknown> {
  return { id: 0, node_id: '', name: label.name, color: label.color, description: label.description, default: false };
}

function issueJson(issue: Issue, repo: Repo): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: Buffer.from(`Issue:${repo.id}:${issue.number}`).toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: issue.user, id: VIEWER.id, node_id: VIEWER.node_id, type: 'User' },
    labels: issue.labels.map((name) => {
      const found = repo.labels.find((l) => l.name === name);
      return found ? labelJson(found) : { name, color: 'ededed', description: '' };
    }),
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.state === 'closed' ? issue.updated_at : null,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
  };
}

function pullJson(pull: Pull, repo: Repo): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: Buffer.from(`PullRequest:${repo.id}:${pull.number}`).toString('base64'),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable: pull.state === 'open',
    merge_commit_sha: pull.merge_commit_sha,
    merged_at: pull.merged ? pull.updated_at : null,
    head: { label: `${repo.owner}:${pull.head}`, ref: pull.head, sha: pull.head_sha },
    base: { label: `${repo.owner}:${pull.base}`, ref: pull.base, sha: pull.base_sha },
    user: { login: pull.user, id: VIEWER.id, node_id: VIEWER.node_id, type: 'User' },
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.state === 'closed' ? pull.updated_at : null,
    html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
  };
}

/** Parse `per_page` / `page` and build a Link header when another page exists. */
function paginate<T>(ctx: RestCtx, items: readonly T[]): { page: T[]; link: string } {
  const perPage = Math.min(100, Math.max(1, Number(ctx.query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(ctx.query.get('page') ?? '1') || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link = '';
  if (start + perPage < items.length) {
    const base = `http://${ctx.host}${ctx.path}`;
    const next = `${base}?per_page=${perPage}&page=${page + 1}`;
    const lastPage = Math.ceil(items.length / perPage);
    const last = `${base}?per_page=${perPage}&page=${lastPage}`;
    link = `<${next}>; rel="next", <${last}>; rel="last"`;
  }
  return { page: [...slice], link };
}

function linkHeaders(link: string): Record<string, string> {
  return link ? { link } : {};
}

/** The repository named by the URL, or null when absent / owned by someone else (404, never 403). */
function findRepo(ctx: RestCtx, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return ctx.store.getRepo(owner, name) ?? null;
}

function decodePathSegment(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** Split the path after /api/v3 into segments. */
function segments(ctx: RestCtx): string[] {
  const rest = ctx.path.startsWith('/api/v3') ? ctx.path.slice('/api/v3'.length) : ctx.path;
  return rest.split('/').filter((s) => s.length > 0).map(decodePathSegment);
}

export function routeRest(ctx: RestCtx): boolean {
  const { method } = ctx;
  const seg = segments(ctx);

  // API root.
  if (seg.length === 0) {
    if (method !== 'GET') return false;
    ok(ctx, 200, {
      current_user_url: '/api/v3/user',
      current_user_authorizations_html_url: 'https://github.com/settings/applications',
      authorizations_url: '/api/v3/authorizations',
      code_search_url: '/api/v3/search/code?q={query}',
      commit_search_url: '/api/v3/search/commits?q={query}',
      emails_url: '/api/v3/user/emails',
      emojis_url: '/api/v3/emojis',
      events_url: '/api/v3/events',
      feeds_url: '/api/v3/feeds',
      followers_url: '/api/v3/user/followers',
      following_url: '/api/v3/user/following{/target}',
      gists_url: '/api/v3/gists{/gist_id}',
      hub_url: 'https://api.github.com/hub',
      issue_search_url: '/api/v3/search/issues?q={query}',
      issues_url: '/api/v3/issues',
      keys_url: '/api/v3/user/keys',
      label_search_url: '/api/v3/search/labels?q={query}',
      notifications_url: '/api/v3/notifications',
      organization_repositories_url: '/api/v3/orgs/{org}/repos',
      organization_url: '/api/v3/orgs/{org}',
      public_gists_url: '/api/v3/gists/public',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      repository_search_url: '/api/v3/search/repositories?q={query}',
      current_user_repositories_url: '/api/v3/user/repos',
      starred_url: '/api/v3/user/starred{/owner}{/repo}',
      starred_gists_url: '/api/v3/gists/starred',
      topic_search_url: '/api/v3/search/topics?q={query}',
      user_url: '/api/v3/users/{user}',
      user_organizations_url: '/api/v3/user/orgs',
      user_repositories_url: '/api/v3/user/repos',
      user_search_url: '/api/v3/search/users?q={query}',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }

  // GET /meta
  if (seg.length === 1 && seg[0] === 'meta') {
    if (method !== 'GET') return false;
    ok(ctx, 200, { verifiable_password_authentication: true, installed_version: '1.0.0', git_protocol_versions: ['0', '1', '2'] });
    return true;
  }

  // GET /user
  if (seg.length === 1 && seg[0] === 'user' && method === 'GET') {
    ok(ctx, 200, {
      login: VIEWER.login, id: VIEWER.id, node_id: VIEWER.node_id, name: VIEWER.name,
      email: VIEWER.email, type: 'User', html_url: `https://github.com/${VIEWER.login}`,
    });
    return true;
  }

  // /user/repos
  if (seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') {
    if (method === 'GET') {
      const { page, link } = paginate(ctx, ctx.store.viewerRepos().map(repoJson));
      ok(ctx, 200, page, linkHeaders(link));
      return true;
    }
    if (method === 'POST') {
      const b = ctx.body;
      if (!isRecord(b)) { err(ctx, 400, 'Invalid JSON body'); return true; }
      const name = typeof b.name === 'string' ? b.name : '';
      if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) { err(ctx, 422, 'Invalid repository name'); return true; }
      if (ctx.store.getRepo(VIEWER.login, name)) { err(ctx, 422, 'Repository already exists'); return true; }
      const repo = ctx.store.createRepo(
        name,
        typeof b.description === 'string' ? b.description : '',
        b.private === true,
        typeof b.default_branch === 'string' ? b.default_branch : 'main',
      );
      ok(ctx, 201, repoJson(repo));
      return true;
    }
    return false;
  }

  // /repos/{owner}/{name}...
  if (seg.length >= 3 && seg[0] === 'repos') {
    const owner = seg[1];
    const name = seg[2];
    const repo = findRepo(ctx, owner, name);
    const rest = seg.slice(3);

    // GET /repos/{o}/{r} ; PATCH ; DELETE
    if (rest.length === 0) {
      if (method === 'GET') {
        if (!repo) { err(ctx, 404, 'Not Found'); return true; }
        ok(ctx, 200, repoJson(repo));
        return true;
      }
      if (method === 'PATCH') {
        if (!repo) { err(ctx, 404, 'Not Found'); return true; }
        const b = ctx.body;
        if (!isRecord(b)) { err(ctx, 400, 'Invalid JSON body'); return true; }
        if (typeof b.description === 'string') repo.description = b.description;
        if (typeof b.default_branch === 'string') repo.defaultBranch = b.default_branch;
        repo.updatedAt = ctx.store.now();
        ok(ctx, 200, repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        if (!repo) { err(ctx, 404, 'Not Found'); return true; }
        ctx.store.deleteRepo(owner, name);
        sendNoContent(ctx.res, { 'x-github-request-id': ctx.requestId });
        return true;
      }
      return false;
    }

    if (!repo) { err(ctx, 404, 'Not Found'); return true; }

    // /branches
    if (rest.length === 1 && rest[0] === 'branches' && method === 'GET') {
      const out = repo.sortedRefs()
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha, url: '' }, protected: false }));
      ok(ctx, 200, out);
      return true;
    }
    if (rest.length === 2 && rest[0] === 'branches' && method === 'GET') {
      const sha = repo.refs.get(`refs/heads/${rest[1]}`);
      if (!sha) { err(ctx, 404, 'Not Found'); return true; }
      ok(ctx, 200, { name: rest[1], commit: { sha, url: '' }, protected: false });
      return true;
    }

    // /commits
    if (rest.length === 1 && rest[0] === 'commits' && method === 'GET') {
      const refName = ctx.query.get('sha') ?? repo.headRef;
      const fullRef = refName.startsWith('refs/') ? refName : `refs/heads/${refName}`;
      const tip = repo.refs.get(fullRef) ?? repo.refs.get(refName);
      if (!tip) { ok(ctx, 200, []); return true; }
      const out = repo.logFrom(tip).map((sha) => {
        const obj = repo.objects.get(sha);
        const view = obj ? parseCommit(obj.data) : null;
        return {
          sha,
          commit: {
            message: view?.message ?? '',
            author: { name: VIEWER.name, email: VIEWER.email },
            committer: { name: VIEWER.name, email: VIEWER.email },
            tree: { sha: view?.tree ?? '' },
          },
          author: { login: VIEWER.login },
          committer: { login: VIEWER.login },
          parents: (view?.parents ?? []).map((p) => ({ sha: p })),
        };
      });
      const { page, link } = paginate(ctx, out);
      ok(ctx, 200, page, linkHeaders(link));
      return true;
    }

    // /git/refs
    if (rest.length >= 2 && rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const b = ctx.body;
        if (!isRecord(b)) { err(ctx, 400, 'Invalid JSON body'); return true; }
        const ref = typeof b.ref === 'string' ? b.ref : '';
        const sha = typeof b.sha === 'string' ? b.sha : '';
        if (!ref.startsWith('refs/') || !repo.objects.has(sha)) { err(ctx, 422, 'Invalid ref or sha'); return true; }
        if (repo.refs.has(ref)) { err(ctx, 422, 'Reference already exists'); return true; }
        repo.refs.set(ref, sha);
        ok(ctx, 201, { ref, node_id: '', object: { sha, type: 'commit', url: '' } });
        return true;
      }
      if (method === 'GET' && rest.length >= 3) {
        const ref = `refs/${rest.slice(2).join('/')}`;
        const sha = repo.refs.get(ref);
        if (!sha) { err(ctx, 404, 'Not Found'); return true; }
        ok(ctx, 200, { ref, node_id: '', object: { sha, type: 'commit', url: '' } });
        return true;
      }
      return false;
    }

    // /contents/{path...}
    if (rest.length >= 1 && rest[0] === 'contents') {
      return routeContents(ctx, repo, rest.slice(1));
    }

    // /labels
    if (rest.length === 1 && rest[0] === 'labels') {
      if (method === 'GET') { ok(ctx, 200, repo.labels.map(labelJson)); return true; }
      if (method === 'POST') {
        const b = ctx.body;
        if (!isRecord(b)) { err(ctx, 400, 'Invalid JSON body'); return true; }
        const lname = typeof b.name === 'string' ? b.name : '';
        if (!lname) { err(ctx, 422, 'Invalid label name'); return true; }
        if (repo.labels.some((l) => l.name === lname)) { err(ctx, 422, 'Label already exists'); return true; }
        const label = { name: lname, color: typeof b.color === 'string' ? b.color.replace(/^#/, '') : 'ededed', description: typeof b.description === 'string' ? b.description : '' };
        repo.labels.push(label);
        ok(ctx, 201, labelJson(label));
        return true;
      }
      return false;
    }

    // /issues...
    if (rest.length >= 1 && rest[0] === 'issues') {
      return routeIssues(ctx, repo, rest.slice(1));
    }

    // /pulls...
    if (rest.length >= 1 && rest[0] === 'pulls') {
      return routePulls(ctx, repo, rest.slice(1));
    }

    return false;
  }

  return false;
}

// --------------------------------------------------------------------------- contents

function routeContents(ctx: RestCtx, repo: Repo, pathParts: string[]): boolean {
  const { method } = ctx;
  const path = pathParts.join('/');
  const branchName = typeof ctx.body === 'object' && ctx.body !== null && !Array.isArray(ctx.body)
    ? (ctx.body as Record<string, unknown>).branch
    : undefined;
  const branch = typeof branchName === 'string' && branchName ? branchName : repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  const tip = repo.refs.get(refName);
  const flat = tip ? repo.flatAt(refName) : new Map<string, { oid: string; mode: string }>();

  if (method === 'GET') {
    const refQuery = ctx.query.get('ref');
    const useFlat = refQuery ? repo.flatAt(refQuery.startsWith('refs/') ? refQuery : `refs/heads/${refQuery}`) : flat;
    if (!path) {
      // Root directory listing.
      const entries = dirListing(repo, useFlat, '');
      ok(ctx, 200, entries);
      return true;
    }
    const entry = useFlat.get(path);
    if (entry) {
      const obj = repo.objects.get(entry.oid);
      const data = obj?.data ?? Buffer.alloc(0);
      ok(ctx, 200, {
        type: 'file', encoding: 'base64', size: data.length, name: path.split('/').pop(),
        path, content: data.toString('base64'), sha: entry.oid,
        url: '', git_url: '', html_url: '', download_url: '', _links: {},
      });
      return true;
    }
    // A directory?
    const prefix = `${path}/`;
    if ([...useFlat.keys()].some((p) => p.startsWith(prefix))) {
      ok(ctx, 200, dirListing(repo, useFlat, path));
      return true;
    }
    err(ctx, 404, 'Not Found');
    return true;
  }

  if (method === 'PUT') {
    const b = ctx.body;
    if (!isRecord(b)) { err(ctx, 400, 'Invalid JSON body'); return true; }
    const contentB64 = typeof b.content === 'string' ? b.content : '';
    const message = typeof b.message === 'string' ? b.message : `Update ${path}`;
    let data: Buffer;
    try { data = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64'); } catch { err(ctx, 422, 'Invalid base64 content'); return true; }
    const existing = flat.get(path);
    if (existing && typeof b.sha !== 'string') { err(ctx, 422, 'sha is required to update a file'); return true; }
    if (existing && typeof b.sha === 'string' && b.sha.toLowerCase() !== existing.oid.toLowerCase()) {
      err(ctx, 409, 'sha does not match the current file');
      return true;
    }
    if (!existing && typeof b.sha === 'string') { err(ctx, 422, 'sha does not match: file does not exist'); return true; }
    if (branchName && typeof branchName === 'string' && !repo.refs.has(refName)) { err(ctx, 422, 'Invalid branch'); return true; }
    const blobOid = storeObject(repo.objects, 'blob', data);
    const next = new Map(flat);
    next.set(path, { oid: blobOid, mode: '100644' });
    const parents = tip ? [tip] : [];
    const commitOid = repo.createCommit(next, message, parents, ctx.store.authorLine());
    repo.refs.set(refName, commitOid);
    repo.updatedAt = ctx.store.now();
    ok(ctx, existing ? 200 : 201, {
      content: { name: path.split('/').pop(), path, sha: blobOid, size: data.length, url: '', git_url: '', html_url: '', download_url: '', type: 'file', content: contentB64, encoding: 'base64', _links: {} },
      commit: { sha: commitOid, message, author: { name: VIEWER.name, email: VIEWER.email }, committer: { name: VIEWER.name, email: VIEWER.email } },
    });
    return true;
  }

  if (method === 'DELETE') {
    const b = ctx.body;
    if (!isRecord(b)) { err(ctx, 400, 'Invalid JSON body'); return true; }
    const existing = flat.get(path);
    if (!existing) { err(ctx, 404, 'Not Found'); return true; }
    if (typeof b.sha === 'string' && b.sha.toLowerCase() !== existing.oid.toLowerCase()) {
      err(ctx, 409, 'sha does not match the current file');
      return true;
    }
    const message = typeof b.message === 'string' ? b.message : `Delete ${path}`;
    const next = new Map(flat);
    next.delete(path);
    const parents = tip ? [tip] : [];
    const commitOid = repo.createCommit(next, message, parents, ctx.store.authorLine());
    repo.refs.set(refName, commitOid);
    repo.updatedAt = ctx.store.now();
    ok(ctx, 200, { commit: { sha: commitOid, message } });
    return true;
  }

  return false;
}

function dirListing(repo: Repo, flat: Map<string, { oid: string; mode: string }>, dir: string): Array<Record<string, unknown>> {
  const prefix = dir ? `${dir}/` : '';
  const seen = new Map<string, { type: string; oid?: string; size?: number }>();
  for (const [path, entry] of flat) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      const obj = repo.objects.get(entry.oid);
      seen.set(rest, { type: 'file', oid: entry.oid, size: obj?.data.length ?? 0 });
    } else {
      seen.set(rest.slice(0, slash), { type: 'dir' });
    }
  }
  return [...seen.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([name, v]) => ({
    type: v.type,
    size: v.type === 'file' ? (v.size ?? 0) : 0,
    name,
    path: prefix + name,
    sha: v.oid ?? '',
    url: '', git_url: '', html_url: '', download_url: v.type === 'file' ? '' : null,
    _links: {},
  }));
}

// --------------------------------------------------------------------------- issues

function routeIssues(ctx: RestCtx, repo: Repo, rest: string[]): boolean {
  const { method } = ctx;

  if (rest.length === 0) {
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const sort = ctx.query.get('sort') ?? 'created';
      const direction = ctx.query.get('direction') ?? 'desc';
      let list = [...repo.issues];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      const byCreated = (a: Issue, b: Issue): number => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.number - b.number);
      list.sort(sort === 'created' ? byCreated : byCreated);
      if (direction === 'desc') list.reverse();
      const { page, link } = paginate(ctx, list.map((i) => issueJson(i, repo)));
      ok(ctx, 200, page, linkHeaders(link));
      return true;
    }
    if (method === 'POST') {
      const b = ctx.body;
      if (!isRecord(b)) { err(ctx, 400, 'Invalid JSON body'); return true; }
      const title = typeof b.title === 'string' ? b.title : '';
      if (!title) { err(ctx, 422, 'Invalid title'); return true; }
      const labels = Array.isArray(b.labels) ? b.labels.filter((l): l is string => typeof l === 'string') : [];
      for (const l of labels) {
        if (!repo.labels.some((x) => x.name === l)) { err(ctx, 422, `Label does not exist: ${l}`); return true; }
      }
      const now = ctx.store.now();
      const issue: Issue = {
        id: repo.id * 100000 + repo.nextIssue,
        number: repo.nextIssue,
        title,
        body: typeof b.body === 'string' ? b.body : '',
        state: 'open',
        labels,
        comments: [],
        created_at: now,
        updated_at: now,
        user: VIEWER.login,
      };
      repo.nextIssue += 1;
      repo.issues.push(issue);
      ok(ctx, 201, issueJson(issue, repo));
      return true;
    }
    return false;
  }

  const num = Number(rest[0]);
  if (!Number.isInteger(num)) return false;
  const issue = repo.issues.find((i) => i.number === num);

  if (rest.length === 1) {
    if (method === 'GET') {
      if (!issue) { err(ctx, 404, 'Not Found'); return true; }
      ok(ctx, 200, issueJson(issue, repo));
      return true;
    }
    if (method === 'PATCH') {
      if (!issue) { err(ctx, 404, 'Not Found'); return true; }
      const b = ctx.body;
      if (!isRecord(b)) { err(ctx, 400, 'Invalid JSON body'); return true; }
      if (typeof b.title === 'string') issue.title = b.title;
      if (typeof b.body === 'string') issue.body = b.body;
      if (b.state === 'open' || b.state === 'closed') issue.state = b.state;
      if (Array.isArray(b.labels)) {
        const labels = b.labels.filter((l): l is string => typeof l === 'string');
        for (const l of labels) if (!repo.labels.some((x) => x.name === l)) { err(ctx, 422, `Label does not exist: ${l}`); return true; }
        issue.labels = labels;
      }
      issue.updated_at = ctx.store.now();
      ok(ctx, 200, issueJson(issue, repo));
      return true;
    }
    return false;
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (!issue) { err(ctx, 404, 'Not Found'); return true; }
    if (method === 'GET') {
      ok(ctx, 200, issue.comments.map((c) => ({
        id: c.id, node_id: '', body: c.body, user: { login: c.user, id: VIEWER.id },
        created_at: c.created_at, updated_at: c.updated_at,
      })));
      return true;
    }
    if (method === 'POST') {
      const b = ctx.body;
      if (!isRecord(b)) { err(ctx, 400, 'Invalid JSON body'); return true; }
      const body = typeof b.body === 'string' ? b.body : '';
      if (!body) { err(ctx, 422, 'Invalid body'); return true; }
      const now = ctx.store.now();
      const comment = { id: repo.nextCommentId, body, user: VIEWER.login, created_at: now, updated_at: now };
      repo.nextCommentId += 1;
      issue.comments.push(comment);
      issue.updated_at = now;
      ok(ctx, 201, { id: comment.id, node_id: '', body: comment.body, user: { login: VIEWER.login, id: VIEWER.id }, created_at: now, updated_at: now });
      return true;
    }
    return false;
  }

  return false;
}

// --------------------------------------------------------------------------- pull requests

function routePulls(ctx: RestCtx, repo: Repo, rest: string[]): boolean {
  const { method } = ctx;

  if (rest.length === 0) {
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let list = [...repo.pulls];
      if (state !== 'all') list = list.filter((p) => p.state === state);
      list.sort((a, b) => b.number - a.number);
      const { page, link } = paginate(ctx, list.map((p) => pullJson(p, repo)));
      ok(ctx, 200, page, linkHeaders(link));
      return true;
    }
    if (method === 'POST') {
      const b = ctx.body;
      if (!isRecord(b)) { err(ctx, 400, 'Invalid JSON body'); return true; }
      const title = typeof b.title === 'string' ? b.title : '';
      const head = typeof b.head === 'string' ? b.head : '';
      const base = typeof b.base === 'string' ? b.base : '';
      if (!title || !head || !base) { err(ctx, 422, 'title, head and base are required'); return true; }
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) { err(ctx, 422, 'Invalid head or base branch'); return true; }
      if (repo.pulls.some((p) => p.state === 'open' && p.head === head && p.base === base)) {
        err(ctx, 422, 'A pull request already exists for this head and base');
        return true;
      }
      const now = ctx.store.now();
      const pull: Pull = {
        id: repo.id * 100000 + 50000 + repo.nextPull,
        number: repo.nextPull,
        title,
        body: typeof b.body === 'string' ? b.body : '',
        state: 'open',
        merged: false,
        merge_commit_sha: null,
        head,
        base,
        head_sha: headSha,
        base_sha: baseSha,
        created_at: now,
        updated_at: now,
        user: VIEWER.login,
      };
      repo.nextPull += 1;
      repo.pulls.push(pull);
      ok(ctx, 201, pullJson(pull, repo));
      return true;
    }
    return false;
  }

  const num = Number(rest[0]);
  if (!Number.isInteger(num)) return false;
  const pull = repo.pulls.find((p) => p.number === num);

  if (rest.length === 1) {
    if (method === 'GET') {
      if (!pull) { err(ctx, 404, 'Not Found'); return true; }
      ok(ctx, 200, pullJson(pull, repo));
      return true;
    }
    return false;
  }

  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    if (!pull) { err(ctx, 404, 'Not Found'); return true; }
    const files = repo.diffFiles(pull.base_sha, pull.head_sha).map((f) => ({
      sha: '',
      filename: f.path,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.additions + f.deletions,
      blob_url: '',
      raw_url: '',
      contents_url: '',
    }));
    ok(ctx, 200, files);
    return true;
  }

  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    if (!pull) { err(ctx, 404, 'Not Found'); return true; }
    if (pull.state === 'closed') { err(ctx, 405, 'Pull request is already closed'); return true; }
    const b = ctx.body;
    const mergeMethod = isRecord(b) && typeof b.merge_method === 'string' ? b.merge_method : 'squash';
    if (mergeMethod !== 'squash' && mergeMethod !== 'merge' && mergeMethod !== 'rebase') {
      err(ctx, 422, 'Invalid merge_method');
      return true;
    }
    const message = `Merge pull request #${pull.number} from ${pull.head}`;
    const sha = repo.squashMerge(pull, ctx.store.authorLine(), message);
    if (!sha) { err(ctx, 405, 'Merge conflict'); return true; }
    pull.state = 'closed';
    pull.merged = true;
    pull.merge_commit_sha = sha;
    pull.updated_at = ctx.store.now();
    ok(ctx, 200, { sha, merged: true, message });
    return true;
  }

  if (rest.length === 2 && rest[1] === 'merge' && method === 'GET') {
    if (!pull) { err(ctx, 404, 'Not Found'); return true; }
    if (!pull.merged) { err(ctx, 404, 'Not Found'); return true; }
    sendNoContent(ctx.res, { 'x-github-request-id': ctx.requestId });
    return true;
  }

  return false;
}
