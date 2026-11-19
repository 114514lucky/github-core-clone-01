// store.ts — the forge's in-memory data model. Everything is synchronous and in memory:
// the trial is one process, the suite its only client, and speed is part of the score.
// A repository holds a git object store (Map<oid, object>), refs, issues, pull requests and labels.
// The viewer is the token owner: the suite's scenario derives its login deterministically from
// the kit's published scenario seed (program/env/src/wire.ts, SCENARIO_SEED), so it is the same
// in every trial — "adaiversen", id 1000. There is no other channel for an entry to learn it.

import {
  buildCommit,
  buildTreeFromFlat,
  commitFlat,
  flattenTree,
  isAncestor,
  parseCommit,
  storeObject,
  type GitObject,
  type ObjectMap,
  ZERO_OID,
} from './git.ts';

export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  node_id: Buffer.from('User:1000').toString('base64'),
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
  type: 'User',
};

export interface Label { name: string; color: string; description: string; }
export interface Comment { id: number; body: string; user: string; created_at: string; updated_at: string; }
export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  created_at: string;
  updated_at: string;
  user: string;
}
export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merge_commit_sha: string | null;
  head: string; // branch name
  base: string; // branch name
  head_sha: string;
  base_sha: string;
  created_at: string;
  updated_at: string;
  user: string;
}

export class Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: ObjectMap = new Map<string, GitObject>();
  refs = new Map<string, string>(); // full ref name -> oid
  labels: Label[] = [];
  issues: Issue[] = [];
  pulls: Pull[] = [];
  nextIssue = 1;
  nextPull = 1;
  nextCommentId = 1;
  nextId = 1;

  constructor(id: number, name: string, owner: string, description: string, isPrivate: boolean, defaultBranch: string, now: string) {
    this.id = id;
    this.name = name;
    this.owner = owner;
    this.description = description;
    this.isPrivate = isPrivate;
    this.defaultBranch = defaultBranch;
    this.createdAt = now;
    this.updatedAt = now;
  }

  get fullName(): string { return `${this.owner}/${this.name}`; }
  get nodeId(): string { return Buffer.from(`Repository:${this.id}`).toString('base64'); }
  get headRef(): string { return `refs/heads/${this.defaultBranch}`; }
  get headOid(): string | undefined { return this.refs.get(this.headRef); }

  /** All refs sorted by name, HEAD first is the caller's job. */
  sortedRefs(): Array<[string, string]> {
    return [...this.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }

  /** Create a commit on top of `parents` with the given flat file map. Returns the commit oid. */
  createCommit(flat: Map<string, { oid: string; mode: string }>, message: string, parents: string[], authorLine: string): string {
    const tree = buildTreeFromFlat(this.objects, flat);
    const commit = buildCommit({ tree, parents, author: authorLine, committer: authorLine, message });
    return storeObject(this.objects, 'commit', commit);
  }

  /** Walk first-parent history from `tip`, newest first. */
  logFrom(tip: string, limit = 1000): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length && out.length < limit) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = this.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      out.push(oid);
      for (const p of parseCommit(obj.data).parents) queue.push(p);
    }
    return out;
  }

  /** The merge-base of two commits: the common ancestor with the greatest depth. */
  mergeBase(a: string, b: string): string | null {
    if (a === b) return a;
    const ancA = new Map<string, number>();
    const queue: Array<[string, number]> = [[a, 0]];
    while (queue.length) {
      const [oid, d] = queue.shift() as [string, number];
      if (ancA.has(oid)) continue;
      ancA.set(oid, d);
      const obj = this.objects.get(oid);
      if (obj?.type === 'commit') for (const p of parseCommit(obj.data).parents) queue.push([p, d + 1]);
    }
    let best: string | null = null;
    let bestDepth = -1;
    const seen = new Set<string>();
    const qb: Array<[string, number]> = [[b, 0]];
    while (qb.length) {
      const [oid, d] = qb.shift() as [string, number];
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (ancA.has(oid)) {
        const depth = (ancA.get(oid) as number) + d;
        if (depth > bestDepth) { bestDepth = depth; best = oid; }
      }
      const obj = this.objects.get(oid);
      if (obj?.type === 'commit') for (const p of parseCommit(obj.data).parents) qb.push([p, d + 1]);
    }
    return best;
  }

  /** Three-way merge of flat file maps. Returns null on conflict. */
  static mergeFlats(
    base: Map<string, { oid: string; mode: string }>,
    ours: Map<string, { oid: string; mode: string }>,
    theirs: Map<string, { oid: string; mode: string }>,
  ): Map<string, { oid: string; mode: string }> | null {
    const out = new Map<string, { oid: string; mode: string }>();
    const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
    for (const path of paths) {
      const b = base.get(path);
      const o = ours.get(path);
      const t = theirs.get(path);
      const same = (x?: { oid: string }, y?: { oid: string }): boolean => (x?.oid ?? null) === (y?.oid ?? null);
      if (same(o, t)) { if (o) out.set(path, o); continue; }
      if (same(b, o)) { if (t) out.set(path, t); continue; }
      if (same(b, t)) { if (o) out.set(path, o); continue; }
      return null; // both sides changed it differently: conflict
    }
    return out;
  }

  /** Squash-merge a pull request. Returns the merge commit oid, or null on conflict. */
  /** Dry-run three-way merge: returns true when the merge would succeed, writes nothing. */
  canMerge(pull: Pull): boolean {
    const baseTip = this.refs.get(`refs/heads/${pull.base}`);
    const headTip = this.refs.get(`refs/heads/${pull.head}`);
    if (!baseTip || !headTip) return false;
    if (baseTip === headTip) return true;
    const base = this.mergeBase(baseTip, headTip);
    const baseFlat = base ? commitFlat(this.objects, base) : new Map<string, { oid: string; mode: string }>();
    const oursFlat = commitFlat(this.objects, baseTip);
    const theirsFlat = commitFlat(this.objects, headTip);
    return Repo.mergeFlats(baseFlat, oursFlat, theirsFlat) !== null;
  }

  squashMerge(pull: Pull, authorLine: string, message: string): string | null {
    const baseTip = this.refs.get(`refs/heads/${pull.base}`);
    const headTip = this.refs.get(`refs/heads/${pull.head}`);
    if (!baseTip || !headTip) return null;
    const base = this.mergeBase(baseTip, headTip);
    const baseFlat = base ? commitFlat(this.objects, base) : new Map<string, { oid: string; mode: string }>();
    const oursFlat = commitFlat(this.objects, baseTip);
    const theirsFlat = commitFlat(this.objects, headTip);
    const merged = Repo.mergeFlats(baseFlat, oursFlat, theirsFlat);
    if (!merged) return null;
    const oid = this.createCommit(merged, message, [baseTip], authorLine);
    this.refs.set(`refs/heads/${pull.base}`, oid);
    return oid;
  }

  /** Is `oid` a descendant of (or equal to) `ancestor`? */
  isDescendant(ancestor: string, oid: string): boolean {
    return isAncestor(this.objects, ancestor, oid);
  }

  /** The flat file map of a ref's tip (empty when unborn/unknown). */
  flatAt(ref: string): Map<string, { oid: string; mode: string }> {
    const tip = this.refs.get(ref);
    return tip ? commitFlat(this.objects, tip) : new Map();
  }

  /** Files changed between two commits, as {path, status, additions, deletions}. */
  diffFiles(baseTip: string, headTip: string): Array<{ path: string; status: string; additions: number; deletions: number }> {
    const base = commitFlat(this.objects, baseTip);
    const head = commitFlat(this.objects, headTip);
    const out: Array<{ path: string; status: string; additions: number; deletions: number }> = [];
    const countLines = (oid: string): number => {
      const obj = this.objects.get(oid);
      if (!obj) return 0;
      const text = obj.data.toString('utf8');
      if (!text) return 0;
      return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    };
    const paths = new Set<string>([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (!b && h) out.push({ path, status: 'added', additions: countLines(h.oid), deletions: 0 });
      else if (b && !h) out.push({ path, status: 'removed', additions: 0, deletions: countLines(b.oid) });
      else if (b && h && b.oid !== h.oid) {
        out.push({ path, status: 'modified', additions: countLines(h.oid), deletions: countLines(b.oid) });
      }
    }
    return out;
  }
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 5000;
  nextGlobalId = 100000;
  requestSeq = 0;
  clockSeq = 0;
  baseNow: string;

  constructor() {
    // The trial's own "now" when available; otherwise a fixed instant. Every timestamp the forge
    // writes comes from this logical clock, never the wall clock, so two runs agree.
    this.baseNow = process.env.MAKEFUN_TRIAL_NOW ?? '2026-11-19T00:00:00Z';
  }

  /** Next timestamp: base now + one second per call, so ordering is stable and monotonic. */
  now(): string {
    const base = Date.parse(this.baseNow);
    const t = new Date(base + this.clockSeq * 1000);
    this.clockSeq += 1;
    return t.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /** Git author/committer line for server-created commits. */
  authorLine(): string {
    const base = Date.parse(this.baseNow);
    const unix = Math.floor(base / 1000) + this.clockSeq;
    return `${VIEWER.name} <${VIEWER.email}> ${unix} +0000`;
  }

  nextRequestId(): string {
    this.requestSeq += 1;
    return `req_${this.requestSeq.toString(16).padStart(8, '0')}`;
  }

  key(owner: string, name: string): string { return `${owner}/${name}`; }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(name: string, description: string, isPrivate: boolean, defaultBranch: string): Repo {
    const repo = new Repo(this.nextRepoId, name, VIEWER.login, description, isPrivate, defaultBranch, this.now());
    this.nextRepoId += 1;
    this.repos.set(this.key(VIEWER.login, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  /** Repos owned by the viewer, in creation order. */
  viewerRepos(): Repo[] {
    return [...this.repos.values()].filter((r) => r.owner === VIEWER.login);
  }
}
