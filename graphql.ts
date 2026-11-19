// graphql.ts — a small GraphQL executor for exactly the documents gh and github-mcp-server
// send (see program/env/src/checks-graphql.ts: 17 fixed documents). It parses the query
// language subset those documents use (operations, variables, arguments, inline fragments,
// aliases), resolves against the same store REST uses, and answers unknown fields with a
// 200 + errors array, as GitHub does. No external GraphQL library exists in the sandbox.

import { Store, VIEWER, type Issue, type Pull, type Repo } from './store.ts';

// --------------------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Record<string, ValueNode>;
  children: SelectionNode[];
}
interface FragmentNode { kind: 'fragment'; typeCondition: string | null; children: SelectionNode[]; }
type SelectionNode = FieldNode | FragmentNode;
interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, { type: string; default?: ValueNode }>;
  children: SelectionNode[];
}

class GqlParseError extends Error {}

class Parser {
  private pos = 0;
  private readonly src: string;
  constructor(src: string) { this.src = src; }

  private skipIgnored(): void {
    for (;;) {
      const c = this.src[this.pos];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { this.pos += 1; continue; }
      if (c === '#') { while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos += 1; continue; }
      return;
    }
  }

  private peek(): string { this.skipIgnored(); return this.src[this.pos] ?? ''; }
  private eat(ch: string): boolean {
    this.skipIgnored();
    if (this.src[this.pos] === ch) { this.pos += 1; return true; }
    return false;
  }
  private expect(ch: string): void {
    if (!this.eat(ch)) throw new GqlParseError(`expected '${ch}' at ${this.pos}`);
  }
  private readName(): string {
    this.skipIgnored();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.pos));
    if (!m) throw new GqlParseError(`expected a name at ${this.pos}`);
    this.pos += m[0].length;
    return m[0];
  }
  private readString(): string {
    this.expect('"');
    let out = '';
    for (;;) {
      const c = this.src[this.pos];
      if (c === undefined) throw new GqlParseError('unterminated string');
      if (c === '"') { this.pos += 1; return out; }
      if (c === '\\') {
        this.pos += 1;
        const e = this.src[this.pos];
        this.pos += 1;
        out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e ?? '';
        continue;
      }
      out += c;
      this.pos += 1;
    }
  }

  parseValue(): ValueNode {
    this.skipIgnored();
    const c = this.src[this.pos];
    if (c === '$') { this.pos += 1; return { kind: 'variable', name: this.readName() }; }
    if (c === '"') return { kind: 'string', value: this.readString() };
    if (c === '[') {
      this.pos += 1;
      const values: ValueNode[] = [];
      while (!this.eat(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (c === '{') {
      this.pos += 1;
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.eat('}')) {
        const name = this.readName();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(this.src.slice(this.pos));
      if (!m) throw new GqlParseError(`bad number at ${this.pos}`);
      this.pos += m[0].length;
      return m[0].includes('.') || /[eE]/.test(m[0])
        ? { kind: 'float', value: Number(m[0]) }
        : { kind: 'int', value: Number(m[0]) };
    }
    const name = this.readName();
    if (name === 'true') return { kind: 'boolean', value: true };
    if (name === 'false') return { kind: 'boolean', value: false };
    if (name === 'null') return { kind: 'null' };
    return { kind: 'enum', value: name };
  }

  parseArguments(): Record<string, ValueNode> {
    const args: Record<string, ValueNode> = {};
    if (!this.eat('(')) return args;
    while (!this.eat(')')) {
      const name = this.readName();
      this.expect(':');
      args[name] = this.parseValue();
    }
    return args;
  }

  parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const out: SelectionNode[] = [];
    while (!this.eat('}')) {
      if (this.src.startsWith('...', this.pos)) {
        this.pos += 3;
        this.skipIgnored();
        let typeCondition: string | null = null;
        if (this.src.startsWith('on', this.pos) && !/[A-Za-z0-9_]/.test(this.src[this.pos + 2] ?? '')) {
          this.pos += 2;
          typeCondition = this.readName();
        }
        out.push({ kind: 'fragment', typeCondition, children: this.parseSelectionSet() });
        continue;
      }
      const first = this.readName();
      let alias: string | null = null;
      let name = first;
      if (this.eat(':')) { alias = first; name = this.readName(); }
      const args = this.parseArguments();
      const children = this.peek() === '{' ? this.parseSelectionSet() : [];
      out.push({ kind: 'field', name, alias, args, children });
    }
    return out;
  }

  parseDocument(): OperationNode[] {
    const ops: OperationNode[] = [];
    while (this.pos < this.src.length) {
      this.skipIgnored();
      if (this.pos >= this.src.length) break;
      if (this.peek() === '{') {
        ops.push({ kind: 'operation', operation: 'query', name: null, variables: {}, children: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.readName();
      if (keyword !== 'query' && keyword !== 'mutation') throw new GqlParseError(`unexpected '${keyword}'`);
      let name: string | null = null;
      if (/[A-Za-z_]/.test(this.peek())) name = this.readName();
      const variables: Record<string, { type: string; default?: ValueNode }> = {};
      if (this.eat('(')) {
        while (!this.eat(')')) {
          if (!this.eat('$')) throw new GqlParseError('expected $ in variable definition');
          const vname = this.readName();
          this.expect(':');
          // Read the type: a name, possibly wrapped in [] and suffixed with !.
          this.skipIgnored();
          let type = '';
          while (this.pos < this.src.length) {
            const c = this.src[this.pos];
            if (/[A-Za-z0-9_\[\]!]/.test(c)) { type += c; this.pos += 1; } else break;
          }
          let def: ValueNode | undefined;
          if (this.eat('=')) def = this.parseValue();
          variables[vname] = def !== undefined ? { type, default: def } : { type };
        }
      }
      ops.push({ kind: 'operation', operation: keyword, name, variables, children: this.parseSelectionSet() });
    }
    return ops;
  }
}

// --------------------------------------------------------------------------- value resolution

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.name];
    case 'string': case 'int': case 'float': case 'boolean': case 'enum': return node.value;
    case 'null': return null;
    case 'list': return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}

// --------------------------------------------------------------------------- schema (for validation + introspection)

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'createdAt', 'updatedAt'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'url'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body', 'createdAt', 'updatedAt'],
  User: ['login', 'id', 'name'],
  Ref: ['name'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  FileConnection: ['nodes', 'pageInfo'],
  ChangedFile: ['path'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  Comment: ['id', 'body'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};

const INTROSPECTION_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'url'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body', 'createdAt', 'updatedAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'createdAt', 'updatedAt'],
};

// --------------------------------------------------------------------------- execution

interface Ctx {
  store: Store;
  errors: Array<{ message: string }>;
}

function typeOf(value: unknown): string {
  if (value === null || value === undefined) return 'Null';
  if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>).__typename);
  }
  return 'Unknown';
}

function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

function issueNodeId(repo: Repo, issue: Issue): string {
  return Buffer.from(`Issue:${repo.id}:${issue.number}`).toString('base64');
}
function pullNodeId(repo: Repo, pull: Pull): string {
  return Buffer.from(`PullRequest:${repo.id}:${pull.number}`).toString('base64');
}

function cursorFor(n: number): string {
  return Buffer.from(`cursor:${n}`).toString('base64');
}
function numberFromCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function repoObject(repo: Repo): Record<string, unknown> {
  return { __typename: 'Repository', __repo: repo };
}
function issueObject(repo: Repo, issue: Issue): Record<string, unknown> {
  return { __typename: 'Issue', __repo: repo, __issue: issue };
}
function pullObject(repo: Repo, pull: Pull): Record<string, unknown> {
  return { __typename: 'PullRequest', __repo: repo, __pull: pull };
}

function sortIssues(issues: Issue[], orderBy?: Record<string, unknown>): Issue[] {
  const list = [...issues];
  const field = typeof orderBy?.field === 'string' ? orderBy.field : 'CREATED_AT';
  const direction = typeof orderBy?.direction === 'string' ? orderBy.direction : 'DESC';
  if (field === 'CREATED_AT') {
    list.sort((a, b) => {
      if (a.created_at !== b.created_at) return direction === 'DESC'
        ? (a.created_at < b.created_at ? 1 : -1)
        : (a.created_at < b.created_at ? -1 : 1);
      return direction === 'DESC' ? b.number - a.number : a.number - b.number;
    });
  } else {
    list.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
  }
  return list;
}

function executeSelections(
  parent: unknown,
  parentType: string,
  selections: SelectionNode[],
  variables: Record<string, unknown>,
  ctx: Ctx,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition && typeOf(parent) !== sel.typeCondition) continue;
      Object.assign(out, executeSelections(parent, parentType, sel.children, variables, ctx));
      continue;
    }
    const key = sel.alias ?? sel.name;
    const args: Record<string, unknown> = {};
    for (const [name, node] of Object.entries(sel.args)) args[name] = resolveValue(node, variables);
    out[key] = resolveField(parent, parentType, sel, args, variables, ctx);
  }
  return out;
}

function unknownField(parentType: string, name: string, ctx: Ctx): null {
  ctx.errors.push({ message: `Cannot query field "${name}" on type "${parentType}".` });
  return null;
}

function resolveField(
  parent: unknown,
  parentType: string,
  sel: FieldNode,
  args: Record<string, unknown>,
  variables: Record<string, unknown>,
  ctx: Ctx,
): unknown {
  const known = TYPE_FIELDS[parentType];
  if (known && !known.includes(sel.name) && sel.name !== '__typename') return unknownField(parentType, sel.name, ctx);
  const p = (parent ?? {}) as Record<string, unknown>;

  if (sel.name === '__typename') return parentType;

  switch (parentType) {
    case 'Query': {
      if (sel.name === 'viewer') {
        return executeSelections({ __typename: 'User', __user: VIEWER.login }, 'User', sel.children, variables, ctx);
      }
      if (sel.name === 'repository') {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        const repo = ctx.store.getRepo(owner, name);
        if (!repo) return null;
        return executeSelections(repoObject(repo), 'Repository', sel.children, variables, ctx);
      }
      if (sel.name === 'node') {
        const decoded = typeof args.id === 'string' ? decodeGlobalId(args.id) : null;
        if (!decoded) return null;
        if (decoded.kind === 'Repository') {
          const id = Number(decoded.parts[0]);
          const repo = [...ctx.store.repos.values()].find((r) => r.id === id);
          if (!repo) return null;
          return executeSelections(repoObject(repo), 'Repository', sel.children, variables, ctx);
        }
        return null;
      }
      return null;
    }
    case 'Repository': {
      const repo = p.__repo as Repo;
      switch (sel.name) {
        case 'id': return repo.nodeId;
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return repo.fullName;
        case 'owner': return executeSelections({ __typename: 'User', __user: repo.owner }, 'User', sel.children, variables, ctx);
        case 'defaultBranchRef': {
          const tip = repo.refs.get(repo.headRef);
          if (!tip) return null;
          return executeSelections({ __typename: 'Ref', __name: repo.defaultBranch }, 'Ref', sel.children, variables, ctx);
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'description': return repo.description;
        case 'createdAt': return repo.createdAt;
        case 'updatedAt': return repo.updatedAt;
        case 'issue': {
          const issue = repo.issues.find((i) => i.number === Number(args.number));
          if (!issue) return null;
          return executeSelections(issueObject(repo, issue), 'Issue', sel.children, variables, ctx);
        }
        case 'issues': {
          let list = [...repo.issues];
          const states = Array.isArray(args.states) ? args.states.map(String) : null;
          if (states) list = list.filter((i) => states.includes(i.state.toUpperCase()));
          list = sortIssues(list, isRecord(args.orderBy) ? (args.orderBy as Record<string, unknown>) : undefined);
          return connection(list, args, (issue) => executeSelections(issueObject(repo, issue), 'Issue', sel.children.find((c) => c.kind === 'field' && c.name === 'nodes')?.children ?? [], variables, ctx), sel, variables, ctx, 'IssueConnection');
        }
        case 'pullRequest': {
          const pull = repo.pulls.find((x) => x.number === Number(args.number));
          if (!pull) return null;
          return executeSelections(pullObject(repo, pull), 'PullRequest', sel.children, variables, ctx);
        }
        case 'pullRequests': {
          let list = [...repo.pulls].sort((a, b) => b.number - a.number);
          const states = Array.isArray(args.states) ? args.states.map(String) : null;
          if (states) list = list.filter((x) => states.includes(x.state.toUpperCase()));
          return connection(list, args, (pull) => executeSelections(pullObject(repo, pull), 'PullRequest', sel.children.find((c) => c.kind === 'field' && c.name === 'nodes')?.children ?? [], variables, ctx), sel, variables, ctx, 'PullRequestConnection');
        }
        default: return null;
      }
    }
    case 'User': {
      const login = String(p.__user ?? VIEWER.login);
      if (sel.name === 'login') return login;
      if (sel.name === 'id') return login === VIEWER.login ? VIEWER.id : 0;
      if (sel.name === 'name') return login === VIEWER.login ? VIEWER.name : login;
      return null;
    }
    case 'Ref': {
      if (sel.name === 'name') return String(p.__name ?? '');
      return null;
    }
    case 'Issue': {
      const issue = p.__issue as Issue;
      const repo = p.__repo as Repo;
      switch (sel.name) {
        case 'id': return issueNodeId(repo, issue);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'state': return issue.state.toUpperCase();
        case 'body': return issue.body;
        case 'createdAt': return issue.created_at;
        case 'updatedAt': return issue.updated_at;
        case 'author': return executeSelections({ __typename: 'User', __user: issue.user }, 'User', sel.children, variables, ctx);
        case 'url': return `https://github.com/${repo.fullName}/issues/${issue.number}`;
        default: return null;
      }
    }
    case 'PullRequest': {
      const pull = p.__pull as Pull;
      const repo = p.__repo as Repo;
      switch (sel.name) {
        case 'id': return pullNodeId(repo, pull);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'headRefName': return pull.head;
        case 'baseRefName': return pull.base;
        // GitHub's mergeable is a MergeableState enum, not a boolean.
        case 'mergeable': return pull.state !== 'open' ? 'UNKNOWN' : repo.canMerge(pull) ? 'MERGEABLE' : 'CONFLICTING';
        case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged': return pull.merged;
        case 'createdAt': return pull.created_at;
        case 'updatedAt': return pull.updated_at;
        case 'files': {
          const files = repo.diffFiles(pull.base_sha, pull.head_sha);
          const first = typeof args.first === 'number' ? args.first : files.length;
          const nodesSel = sel.children.find((c) => c.kind === 'field' && c.name === 'nodes');
          const nodes = files.slice(0, first).map((f) => executeSelections({ __typename: 'ChangedFile', __path: f.path }, 'ChangedFile', nodesSel?.children ?? [], variables, ctx));
          const out: Record<string, unknown> = {};
          for (const child of sel.children) {
            if (child.kind === 'field' && child.name === 'nodes') out.nodes = nodes;
            else if (child.kind === 'field' && child.name === 'pageInfo') out.pageInfo = { hasNextPage: files.length > first, endCursor: null, hasPreviousPage: false, startCursor: null };
            else if (child.kind === 'field' && child.name === 'totalCount') out.totalCount = files.length;
          }
          return out;
        }
        default: return null;
      }
    }
    case 'ChangedFile': {
      if (sel.name === 'path') return String(p.__path ?? '');
      return null;
    }
    case 'Comment': {
      if (sel.name === 'id') return String(p.__id ?? '');
      if (sel.name === 'body') return String(p.__body ?? '');
      return null;
    }
    case 'Mutation': {
      return resolveMutation(sel, args, ctx);
    }
    default: return null;
  }
}

/** Build a connection object ({nodes, pageInfo, totalCount}) for a pre-sorted list. */
function connection<T>(
  list: T[],
  args: Record<string, unknown>,
  mapNode: (item: T) => unknown,
  sel: FieldNode,
  variables: Record<string, unknown>,
  ctx: Ctx,
  _type: string,
): Record<string, unknown> {
  const first = typeof args.first === 'number' ? args.first : list.length;
  let start = 0;
  if (typeof args.after === 'string') {
    const n = numberFromCursor(args.after);
    if (n !== null) {
      const idx = list.findIndex((item) => {
        const num = (item as { number?: unknown }).number;
        return num === n;
      });
      if (idx >= 0) start = idx + 1;
    }
  }
  const page = list.slice(start, start + first);
  const nodes = page.map(mapNode);
  const out: Record<string, unknown> = {};
  for (const child of sel.children) {
    if (child.kind !== 'field') continue;
    if (child.name === 'nodes') out.nodes = nodes;
    else if (child.name === 'pageInfo') {
      const hasNext = start + first < list.length;
      const last = page[page.length - 1] as { number?: unknown } | undefined;
      out.pageInfo = {
        hasNextPage: hasNext,
        endCursor: last && typeof last.number === 'number' ? cursorFor(last.number) : null,
        hasPreviousPage: start > 0,
        startCursor: null,
      };
    } else if (child.name === 'totalCount') out.totalCount = list.length;
  }
  return out;
}

function resolveMutation(sel: FieldNode, args: Record<string, unknown>, ctx: Ctx): unknown {
  const input = isRecord(args.input) ? (args.input as Record<string, unknown>) : {};
  const store = ctx.store;
  const pick = (children: SelectionNode[], key: string): SelectionNode[] => {
    const found = children.find((c) => c.kind === 'field' && c.name === key);
    return found && found.kind === 'field' ? found.children : [];
  };

  if (sel.name === 'createIssue') {
    const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
    const repo = decoded?.kind === 'Repository'
      ? [...store.repos.values()].find((r) => r.id === Number(decoded.parts[0]))
      : undefined;
    if (!repo) return null;
    const now = store.now();
    const issue: Issue = {
      id: repo.id * 100000 + repo.nextIssue,
      number: repo.nextIssue,
      title: String(input.title ?? ''),
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      labels: [],
      comments: [],
      created_at: now,
      updated_at: now,
      user: VIEWER.login,
    };
    repo.nextIssue += 1;
    repo.issues.push(issue);
    const issueSel = pick(sel.children, 'issue');
    return { issue: executeSelections(issueObject(repo, issue), 'Issue', issueSel, {}, ctx) };
  }

  if (sel.name === 'closeIssue') {
    const decoded = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
    if (!decoded || decoded.kind !== 'Issue') return null;
    const repo = [...store.repos.values()].find((r) => r.id === Number(decoded.parts[0]));
    const issue = repo?.issues.find((i) => i.number === Number(decoded.parts[1]));
    if (!repo || !issue) return null;
    issue.state = 'closed';
    issue.updated_at = store.now();
    const issueSel = pick(sel.children, 'issue');
    return { issue: executeSelections(issueObject(repo, issue), 'Issue', issueSel, {}, ctx) };
  }

  if (sel.name === 'createPullRequest') {
    const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
    const repo = decoded?.kind === 'Repository'
      ? [...store.repos.values()].find((r) => r.id === Number(decoded.parts[0]))
      : undefined;
    if (!repo) return null;
    const head = String(input.headRefName ?? '');
    const base = String(input.baseRefName ?? '');
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (!headSha || !baseSha) return null;
    const now = store.now();
    const pull: Pull = {
      id: repo.id * 100000 + 50000 + repo.nextPull,
      number: repo.nextPull,
      title: String(input.title ?? ''),
      body: typeof input.body === 'string' ? input.body : '',
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
    const pullSel = pick(sel.children, 'pullRequest');
    return { pullRequest: executeSelections(pullObject(repo, pull), 'PullRequest', pullSel, {}, ctx) };
  }

  if (sel.name === 'mergePullRequest') {
    const decoded = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
    if (!decoded || decoded.kind !== 'PullRequest') return null;
    const repo = [...store.repos.values()].find((r) => r.id === Number(decoded.parts[0]));
    const pull = repo?.pulls.find((x) => x.number === Number(decoded.parts[1]));
    if (!repo || !pull || pull.state !== 'open') return null;
    const sha = repo.squashMerge(pull, store.authorLine(), `Merge pull request #${pull.number} from ${pull.head}`);
    if (!sha) return null;
    pull.state = 'closed';
    pull.merged = true;
    pull.merge_commit_sha = sha;
    pull.updated_at = store.now();
    const pullSel = pick(sel.children, 'pullRequest');
    return { pullRequest: executeSelections(pullObject(repo, pull), 'PullRequest', pullSel, {}, ctx) };
  }

  if (sel.name === 'addComment') {
    const decoded = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
    if (!decoded || decoded.kind !== 'Issue') return null;
    const repo = [...store.repos.values()].find((r) => r.id === Number(decoded.parts[0]));
    const issue = repo?.issues.find((i) => i.number === Number(decoded.parts[1]));
    if (!repo || !issue) return null;
    const now = store.now();
    const comment = { id: repo.nextCommentId, body: String(input.body ?? ''), user: VIEWER.login, created_at: now, updated_at: now };
    repo.nextCommentId += 1;
    issue.comments.push(comment);
    const edgeSel = pick(sel.children, 'commentEdge');
    const nodeSel = pick(edgeSel, 'node');
    return {
      commentEdge: {
        node: executeSelections(
          { __typename: 'Comment', __id: Buffer.from(`IssueComment:${repo.id}:${comment.id}`).toString('base64'), __body: comment.body },
          'Comment',
          nodeSel,
          {},
          ctx,
        ),
      },
    };
  }

  return null;
}

// __type introspection.
function introspectType(name: string, children: SelectionNode[], variables: Record<string, unknown>, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const child of children) {
    if (child.kind !== 'field') continue;
    if (child.name === 'name') out.name = name;
    else if (child.name === 'kind') out.kind = name === 'SearchType' ? 'ENUM' : 'OBJECT';
    else if (child.name === 'fields') {
      const names = INTROSPECTION_FIELDS[name] ?? [];
      out.fields = names.map((n) => ({ name: n }));
    } else if (child.name === 'enumValues') {
      out.enumValues = name === 'SearchType'
        ? [{ name: 'ISSUE' }, { name: 'REPOSITORY' }, { name: 'USER' }]
        : [];
    }
  }
  return out;
}

function executeOperation(op: OperationNode, variables: Record<string, unknown>, ctx: Ctx): { data: Record<string, unknown> | null; errors: Array<{ message: string }> } {
  const vars: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(op.variables)) {
    if (name in variables) vars[name] = variables[name];
    else if (def.default) vars[name] = resolveValue(def.default, variables);
  }
  const rootType = op.operation === 'mutation' ? 'Mutation' : 'Query';
  const data: Record<string, unknown> = {};
  for (const sel of op.children) {
    if (sel.kind === 'fragment') continue;
    if (sel.name === '__type') {
      const args: Record<string, unknown> = {};
      for (const [name, node] of Object.entries(sel.args)) args[name] = resolveValue(node, vars);
      const key = sel.alias ?? sel.name;
      data[key] = introspectType(String(args.name ?? ''), sel.children, vars, ctx);
      continue;
    }
    const key = sel.alias ?? sel.name;
    const args: Record<string, unknown> = {};
    for (const [name, node] of Object.entries(sel.args)) args[name] = resolveValue(node, vars);
    data[key] = resolveField({}, rootType, { ...sel, args: {} }, args, vars, ctx);
  }
  return { data, errors: ctx.errors };
}

/** Execute one GraphQL request body. Returns the response object ({data, errors?} or an array for batched bodies). */
export function executeGraphQL(store: Store, body: unknown): unknown {
  const runOne = (doc: { query?: unknown; variables?: unknown; operationName?: unknown }): unknown => {
    const ctx: Ctx = { store, errors: [] };
    const queryText = typeof doc.query === 'string' ? doc.query : '';
    const variables = isRecord(doc.variables) ? (doc.variables as Record<string, unknown>) : {};
    let ops: OperationNode[];
    try {
      ops = new Parser(queryText).parseDocument();
    } catch (e) {
      return { data: null, errors: [{ message: e instanceof Error ? e.message : 'GraphQL parse error' }] };
    }
    if (!ops.length) return { data: null, errors: [{ message: 'Empty query' }] };
    const opName = typeof doc.operationName === 'string' ? doc.operationName : null;
    const op = opName ? ops.find((o) => o.name === opName) ?? ops[0] : ops[0];
    const result = executeOperation(op as OperationNode, variables, ctx);
    return ctx.errors.length ? { data: result.data, errors: ctx.errors } : { data: result.data };
  };
  if (Array.isArray(body)) return body.map((doc) => (isRecord(doc) ? runOne(doc) : { data: null, errors: [{ message: 'Invalid operation' }] }));
  if (isRecord(body)) return runOne(body);
  return { data: null, errors: [{ message: 'Invalid GraphQL body' }] };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
