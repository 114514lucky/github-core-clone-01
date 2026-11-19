// mcp.ts — Model Context Protocol over Streamable HTTP (JSON-RPC 2.0) at POST /mcp.
//
// Speaks the 2026-07-28 era (server/discover, no handshake, no session) and the legacy
// handshake era (initialize + notifications/initialized) — whichever the client probes.
// Tools act on the same store as REST. tools/list is a fixed constant so two calls answer
// byte for byte. Unknown tools answer -32601/-32602, never HTTP 500; a non-JSON body answers
// HTTP 400 with -32700; no Authorization answers 401.

import { Store, VIEWER, type Issue, type Pull, type Repo } from './store.ts';
import type { Ctx } from './http.ts';
import { sendJson, sendNoContent } from './http.ts';

export const MCP_REVISION = '2026-07-28';
export const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const MCP_SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description?: string }>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private (ignored; all repositories are public)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Repository full name "owner/repo"' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Repository full name "owner/repo"' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Repository full name "owner/repo"' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Repository full name "owner/repo"' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash merge onto its base branch).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Repository full name "owner/repo"' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: repo.owner === VIEWER.login ? VIEWER.id : 0, type: 'User' },
    description: repo.description,
    private: false,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: issue.user, id: issue.user === VIEWER.login ? VIEWER.id : 0 },
    labels: issue.labels.map((l) => ({ name: l })),
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merge_commit_sha: pull.merge_commit_sha,
    head: { ref: pull.head, sha: pull.head_sha },
    base: { ref: pull.base, sha: pull.base_sha },
    user: { login: pull.user, id: pull.user === VIEWER.login ? VIEWER.id : 0 },
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
  };
}

/** Resolve owner/repo from arguments, accepting a full_name fallback. */
function resolveRepo(store: Store, args: Record<string, unknown>): Repo | null {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repoName = typeof args.repo === 'string' ? args.repo : '';
  if ((!owner || !repoName) && typeof args.full_name === 'string') {
    const [o, r] = args.full_name.split('/');
    if (o && r) { owner = owner || o; repoName = repoName || r; }
  }
  if (!owner || !repoName) return null;
  return store.getRepo(owner, repoName) ?? null;
}

function toolError(message: string): { content: Array<{ type: string; text: string }>; isError: true } {
  return { content: [{ type: 'text', text: message }], isError: true };
}
function toolOk(value: unknown): { content: Array<{ type: string; text: string }>; structuredContent: unknown; isError: false } {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): { content: Array<{ type: string; text: string }>; structuredContent?: unknown; isError: boolean } {
  const tool = TOOLS.find((t) => t.name.toLowerCase() === name.toLowerCase() || t.name.toLowerCase().endsWith(name.toLowerCase()));
  if (!tool) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };

  // Required-argument check: a missing required argument is a tool error (isError:true).
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      // full_name may stand in for owner/repo.
      if ((required === 'owner' || required === 'repo') && typeof args.full_name === 'string' && args.full_name.includes('/')) continue;
      return toolError(`Missing required argument: ${required}`);
    }
  }

  if (tool.name === 'create_repo') {
    const repoName = String(args.name);
    if (!/^[A-Za-z0-9._-]+$/.test(repoName)) return toolError(`Invalid repository name: ${repoName}`);
    const existing = store.getRepo(VIEWER.login, repoName);
    if (existing) return toolError(`Repository ${VIEWER.login}/${repoName} already exists`);
    const repo = store.createRepo(VIEWER.login, repoName, typeof args.description === 'string' ? args.description : '');
    return toolOk(repoJson(repo));
  }

  if (tool.name === 'get_repo') {
    const repo = resolveRepo(store, args);
    if (!repo) return toolError(`Repository not found: ${String(args.owner ?? '')}/${String(args.repo ?? '')}`);
    return toolOk(repoJson(repo));
  }

  if (tool.name === 'create_issue') {
    const repo = resolveRepo(store, args);
    if (!repo) return toolError(`Repository not found: ${String(args.owner ?? '')}/${String(args.repo ?? '')}`);
    const now = store.now();
    const issue: Issue = {
      id: repo.id * 100000 + repo.nextIssue,
      number: repo.nextIssue,
      title: String(args.title),
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      labels: [],
      comments: [],
      created_at: now,
      updated_at: now,
      user: VIEWER.login,
    };
    repo.nextIssue += 1;
    repo.issues.push(issue);
    return toolOk(issueJson(repo, issue));
  }

  if (tool.name === 'list_issues') {
    const repo = resolveRepo(store, args);
    if (!repo) return toolError(`Repository not found: ${String(args.owner ?? '')}/${String(args.repo ?? '')}`);
    const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
    const list = state === 'all' ? repo.issues : repo.issues.filter((i) => i.state === state);
    return toolOk(list.map((i) => issueJson(repo, i)));
  }

  if (tool.name === 'create_pull_request') {
    const repo = resolveRepo(store, args);
    if (!repo) return toolError(`Repository not found: ${String(args.owner ?? '')}/${String(args.repo ?? '')}`);
    const head = String(args.head);
    const base = String(args.base);
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (!headSha) return toolError(`Head branch not found: ${head}`);
    if (!baseSha) return toolError(`Base branch not found: ${base}`);
    const now = store.now();
    const pull: Pull = {
      id: repo.id * 100000 + 50000 + repo.nextPull,
      number: repo.nextPull,
      title: String(args.title),
      body: typeof args.body === 'string' ? args.body : '',
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
    return toolOk(pullJson(repo, pull));
  }

  if (tool.name === 'merge_pull_request') {
    const repo = resolveRepo(store, args);
    if (!repo) return toolError(`Repository not found: ${String(args.owner ?? '')}/${String(args.repo ?? '')}`);
    const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
    const pull = repo.pulls.find((x) => x.number === number);
    if (!pull) return toolError(`Pull request not found: #${String(args.pull_number)}`);
    if (pull.state !== 'open') return toolError(`Pull request #${number} is ${pull.state}`);
    const sha = repo.squashMerge(pull, store.authorLine(), `Merge pull request #${pull.number} from ${pull.head}`);
    if (!sha) return toolError(`Pull request #${number} cannot be merged (conflict)`);
    pull.state = 'closed';
    pull.merged = true;
    pull.merge_commit_sha = sha;
    pull.updated_at = store.now();
    return toolOk(pullJson(repo, pull));
  }

  return toolError(`Unknown tool: ${name}`);
}

export function handleMcp(ctx: Ctx, store: Store): void {
  const { req, res } = ctx;
  // The body must be JSON. A body that is not JSON answers HTTP 400 with -32700.
  let bodyText = '';
  req.on('data', (chunk: Buffer) => { bodyText += chunk.toString('utf8'); });
  req.on('end', () => {
    let body: unknown;
    try {
      body = JSON.parse(bodyText);
    } catch {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    // Authorization is required for every MCP call.
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ') || auth.length <= 7) {
      sendJson(res, 401, { jsonrpc: '2.0', id: isRecord(body) && 'id' in body ? (body.id as string | number | null) ?? null : null, error: { code: -32000, message: 'Unauthorized' } });
      return;
    }
    if (!isRecord(body)) {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
      return;
    }
    const id = 'id' in body ? (body.id as string | number | null) : undefined;
    const method = typeof body.method === 'string' ? body.method : '';
    const params = isRecord(body.params) ? body.params : {};

    // Notifications carry no id and expect no response body: 202 Accepted.
    if (id === undefined) {
      sendNoContent(res, 202, { 'x-github-request-id': ctx.requestId });
      return;
    }

    const reply = (result: unknown): void => {
      sendJson(res, 200, { jsonrpc: '2.0', id, result });
    };
    const replyError = (code: number, message: string, data?: unknown): void => {
      sendJson(res, 200, { jsonrpc: '2.0', id, error: data !== undefined ? { code, message, data } : { code, message } });
    };

    if (method === 'server/discover') {
      reply({
        supportedVersions: MCP_SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: MCP_SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO },
      });
      return;
    }
    if (method === 'initialize') {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_REVISION;
      const chosen = MCP_SUPPORTED_VERSIONS.includes(offered) ? offered : MCP_REVISION;
      reply({
        protocolVersion: chosen,
        capabilities: { tools: {} },
        serverInfo: MCP_SERVER_INFO,
      });
      return;
    }
    if (method === 'ping') { reply({}); return; }
    if (method === 'tools/list') {
      reply({ tools: TOOLS });
      return;
    }
    if (method === 'tools/call') {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      const matched = TOOLS.some((t) => t.name.toLowerCase() === name.toLowerCase() || name.toLowerCase().endsWith(t.name.toLowerCase()));
      if (!name || !matched) { replyError(-32602, `Unknown tool: ${name}`); return; }
      const result = callTool(store, name, args);
      reply(result);
      return;
    }
    if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
      reply({});
      return;
    }
    replyError(-32601, `Method not found: ${method}`);
  });
  req.on('error', () => {
    try { sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); } catch { /* already answered */ }
  });
}
