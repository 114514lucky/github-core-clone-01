// githttp.ts — git smart HTTP: info/refs advertisements, upload-pack (protocol v2, with a
// v0 fallback the client uses only if v2 is not advertised — it is, so v0 fetch is a safety
// net), and receive-pack (v0 only). No git binary anywhere: packs are built and read here,
// on node:zlib + node:crypto (see git.ts).

import {
  PKT_DELIM,
  PKT_FLUSH,
  collectCommitSet,
  collectReachable,
  decodePktLines,
  hashObject,
  isAncestor,
  parseTag,
  pktLine,
  readPack,
  sidebandPack,
  sidebandText,
  splitRequestBody,
  storeObject,
  writePack,
  ZERO_OID,
  type GitObject,
  type ObjectMap,
} from './git.ts';
import { sendJson, sendRaw } from './http.ts';
import { VIEWER, type Repo, type Store } from './store.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';

const AGENT = 'makefun-forge/1.0';
const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

export interface GitCtx {
  req: IncomingMessage;
  res: ServerResponse;
  store: Store;
  method: string;
  path: string;
  query: URLSearchParams;
  body: Buffer;
  requestId: string;
}

function git404(ctx: GitCtx): void {
  sendJson(ctx.res, 404, { message: 'Not Found' }, { 'x-github-request-id': ctx.requestId });
}

function wantsV2(ctx: GitCtx): boolean {
  const h = ctx.req.headers['git-protocol'];
  return typeof h === 'string' && h.includes('version=2');
}

/** Refs in advertisement order: HEAD first (symref), then refs sorted by name. */
function refLines(repo: Repo): Array<{ oid: string; name: string; peeled?: string }> {
  const out: Array<{ oid: string; name: string; peeled?: string }> = [];
  const headTarget = repo.headRef;
  const headOid = repo.refs.get(headTarget) ?? ZERO_OID;
  out.push({ oid: headOid, name: 'HEAD' });
  for (const [name, oid] of repo.sortedRefs()) {
    const entry: { oid: string; name: string; peeled?: string } = { oid, name };
    const obj = repo.objects.get(oid);
    if (obj?.type === 'tag') {
      const peeled = parseTag(obj.data).object;
      if (peeled) entry.peeled = peeled;
    }
    out.push(entry);
  }
  return out;
}

function v2Advertisement(): Buffer {
  const lines: Buffer[] = [
    pktLine('# service=git-upload-pack\n'),
    PKT_FLUSH,
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    pktLine(`agent=${AGENT}\n`),
    PKT_FLUSH,
  ];
  return Buffer.concat(lines);
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack'
    ? `symref=HEAD:${repo.headRef} report-status thin-pack shallow side-band-64k ofs-delta agent=${AGENT}`
    : `symref=HEAD:${repo.headRef} report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const lines: Buffer[] = [
    pktLine(`# service=${service}\n`),
    PKT_FLUSH,
  ];
  const refs = refLines(repo);
  if (refs.length === 1 && refs[0].oid === ZERO_OID) {
    // Empty repository: the capabilities^{} pseudo-ref carries the capabilities.
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, i) => {
      let line = `${ref.oid} ${ref.name}`;
      if (i === 0) line += `\0${caps}`;
      line += '\n';
      lines.push(pktLine(line));
      if (ref.peeled) lines.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  lines.push(PKT_FLUSH);
  return Buffer.concat(lines);
}

function handleInfoRefs(ctx: GitCtx, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): void {
  if (service === 'git-upload-pack' && wantsV2(ctx)) {
    sendRaw(ctx.res, 200, UPLOAD_AD, v2Advertisement(), { 'x-github-request-id': ctx.requestId });
    return;
  }
  const body = v0Advertisement(repo, service);
  sendRaw(ctx.res, 200, service === 'git-upload-pack' ? UPLOAD_AD : RECEIVE_AD, body, { 'x-github-request-id': ctx.requestId });
}

// --------------------------------------------------------------------------- upload-pack v2

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  deepenSince?: number;
  deepenNot: string[];
  thinPack: boolean;
  noProgress: boolean;
  ofsDelta: boolean;
  filter?: string;
  done: boolean;
}

function parseV2Fetch(packets: ReturnType<typeof decodePktLines>): FetchArgs | null {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepenNot: [], thinPack: false, noProgress: false, ofsDelta: false, done: false };
  let command = '';
  let inArgs = false;
  for (const p of packets) {
    if (p.kind === 'flush') break;
    if (p.kind !== 'data') { if (p.kind === 'delim') inArgs = true; continue; }
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (!inArgs) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
      continue;
    }
    if (line === 'thin-pack') args.thinPack = true;
    else if (line === 'no-progress') args.noProgress = true;
    else if (line === 'ofs-delta') args.ofsDelta = true;
    else if (line === 'done') args.done = true;
    else if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = Number(line.slice(7));
    else if (line.startsWith('deepen-since ')) args.deepenSince = Number(line.slice(13));
    else if (line.startsWith('deepen-not ')) args.deepenNot.push(line.slice(11).trim());
    else if (line.startsWith('filter ')) args.filter = line.slice(7).trim();
  }
  if (command !== 'fetch') return null;
  return args;
}

interface FetchPlan {
  /** Commits to include (by oid). */
  commits: Set<string>;
  /** Shallow boundary commits (have parents, at the depth edge). */
  shallow: string[];
  /** Old boundary commits that are now included. */
  unshallow: string[];
  /** All objects to pack. */
  objects: GitObject[];
}

/** Work out what a fetch sends: reachable from wants, minus what the client has, within the depth limit. */
function planFetch(repo: Repo, args: FetchArgs): FetchPlan {
  const objects = repo.objects;
  // Distances from the wants (BFS over parents).
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const w of args.wants) {
    if (objects.get(w)?.type === 'commit' && !dist.has(w)) { dist.set(w, 0); queue.push(w); }
  }
  while (queue.length) {
    const cur = queue.shift() as string;
    const d = dist.get(cur) as number;
    const obj = objects.get(cur);
    if (!obj || obj.type !== 'commit') continue;
    // parseCommit is imported lazily below via git.ts re-export trick: use a local parse.
    const parents = parseCommitParents(obj.data);
    for (const p of parents) {
      if (!dist.has(p) && objects.has(p)) { dist.set(p, dist.get(cur) as number + 1); queue.push(p); }
    }
  }
  // Depth limit: deepen N means the new total depth is N, i.e. include commits at dist <= N-1.
  // With old shallow boundaries, a boundary at distance b from the wants is the (b+1)-th commit
  // of the old depth, so deepen N extends to dist <= b + N - 1. (Off by one here delivered the
  // grandparent on deepen 2 and re-sent old history on a shallow new-tip fetch.)
  let limit = Infinity;
  if (args.depth !== undefined) {
    let boundaryDist = 0;
    if (args.shallow.length) {
      const bs = args.shallow.map((s) => dist.get(s)).filter((d): d is number => d !== undefined);
      boundaryDist = bs.length ? Math.max(...bs) : 0;
    }
    limit = boundaryDist + args.depth - 1;
  }
  // What the client already holds. A have that is also an old shallow boundary is held only
  // as that commit plus its tree/blobs — a shallow clone holds nothing past the boundary — so
  // it contributes just its own commit set; any other have contributes its full ancestry.
  const haveReachable = new Set<string>();
  for (const h of args.haves) {
    const held = args.shallow.includes(h)
      ? collectCommitSet(objects, [h])
      : collectReachable(objects, [h]).all;
    for (const oid of held) haveReachable.add(oid);
  }
  const commits = new Set<string>();
  for (const [oid, d] of dist) {
    if (d <= limit && !haveReachable.has(oid)) commits.add(oid);
  }
  // Shallow boundary: an included commit with a parent outside the included set. An old
  // boundary is unshallow once the fetch includes one of its parents (the history now runs
  // past it), even when the boundary commit itself was already held and not re-sent.
  const shallow: string[] = [];
  if (args.depth !== undefined) {
    for (const oid of commits) {
      const obj = objects.get(oid);
      if (obj?.type !== 'commit') continue;
      const parents = parseCommitParents(obj.data);
      if (parents.length > 0 && parents.some((p) => !commits.has(p))) shallow.push(oid);
    }
  }
  const unshallow = args.shallow.filter((s) => {
    const obj = objects.get(s);
    if (obj?.type !== 'commit') return false;
    const parents = parseCommitParents(obj.data);
    return parents.length > 0 && parents.some((p) => commits.has(p));
  });
  // Objects: with a depth limit, only the included commits' own trees/blobs (never their
  // parents); without one, everything reachable from the included commits. Either way, minus
  // what the client already holds.
  const reachable = args.depth !== undefined
    ? collectCommitSet(objects, [...commits])
    : collectReachable(objects, [...commits]).all;
  const packObjects: GitObject[] = [];
  for (const oid of reachable) {
    if (haveReachable.has(oid)) continue;
    const obj = objects.get(oid);
    if (obj) packObjects.push(obj);
  }
  // The wanted tips themselves must be present even when they are tags (non-commit wants).
  for (const w of args.wants) {
    if (!haveReachable.has(w)) {
      const obj = objects.get(w);
      if (obj && !packObjects.includes(obj)) {
        packObjects.push(obj);
        if (obj.type === 'tag') {
          const target = parseTag(obj.data).object;
          const t = objects.get(target);
          if (t && !haveReachable.has(target)) packObjects.push(t);
        }
      }
    }
  }
  return { commits, shallow, unshallow, objects: packObjects };
}

function parseCommitParents(data: Buffer): string[] {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return parents;
}

function handleUploadPackV2(ctx: GitCtx, repo: Repo): void {
  const packets = decodePktLines(ctx.body);
  const first = packets.find((p) => p.kind === 'data');
  const firstLine = first ? first.payload.toString('utf8').replace(/\n$/, '') : '';
  const parts: Buffer[] = [];
  const send = (b: Buffer): void => { parts.push(b); };

  if (firstLine.startsWith('command=ls-refs')) {
    let peel = false;
    let symrefs = false;
    let unborn = false;
    const prefixes: string[] = [];
    let inArgs = false;
    for (const p of packets) {
      if (p.kind === 'delim') { inArgs = true; continue; }
      if (p.kind !== 'data' || !inArgs) continue;
      const line = p.payload.toString('utf8').replace(/\n$/, '');
      if (line === 'peel') peel = true;
      else if (line === 'symrefs') symrefs = true;
      else if (line === 'unborn') unborn = true;
      else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
    }
    const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((x) => name.startsWith(x));
    const headOid = repo.refs.get(repo.headRef);
    const lines: string[] = [];
    if (headOid === undefined) {
      if (unborn && keep('HEAD')) lines.push(`unborn HEAD${symrefs ? ` symref-target:${repo.headRef}` : ''}\n`);
    } else if (keep('HEAD')) {
      lines.push(`${headOid} HEAD${symrefs ? ` symref-target:${repo.headRef}` : ''}\n`);
    }
    for (const [name, oid] of repo.sortedRefs()) {
      if (!keep(name)) continue;
      const obj = repo.objects.get(oid);
      let line = `${oid} ${name}`;
      if (peel && obj?.type === 'tag') {
        const peeled = parseTag(obj.data).object;
        if (peeled) line += ` peeled:${peeled}`;
      }
      lines.push(`${line}\n`);
    }
    for (const l of lines) send(pktLine(l));
    send(PKT_FLUSH);
    sendRaw(ctx.res, 200, UPLOAD_RESULT, Buffer.concat(parts), { 'x-github-request-id': ctx.requestId });
    return;
  }

  if (firstLine.startsWith('command=fetch')) {
    const args = parseV2Fetch(packets);
    if (!args) { sendJson(ctx.res, 400, { message: 'Bad fetch command' }, { 'x-github-request-id': ctx.requestId }); return; }
    // Common commits: haves that are ancestors of (or equal to) a want.
    const acks: string[] = [];
    for (const h of args.haves) {
      if (args.wants.some((w) => isAncestor(repo.objects, h, w))) acks.push(h);
    }
    send(pktLine('acknowledgments\n'));
    if (acks.length) {
      for (const a of acks) send(pktLine(`ACK ${a}\n`));
      send(pktLine('ready\n'));
    } else {
      send(pktLine('NAK\n'));
    }
    send(PKT_DELIM);
    const plan = planFetch(repo, args);
    if (args.depth !== undefined) {
      send(pktLine('shallow-info\n'));
      for (const s of plan.shallow) send(pktLine(`shallow ${s}\n`));
      for (const s of plan.unshallow) send(pktLine(`unshallow ${s}\n`));
      send(PKT_DELIM);
    }
    const pack = writePack(plan.objects);
    send(pktLine('packfile\n'));
    send(sidebandPack(pack));
    send(PKT_FLUSH);
    sendRaw(ctx.res, 200, UPLOAD_RESULT, Buffer.concat(parts), { 'x-github-request-id': ctx.requestId });
    return;
  }

  sendJson(ctx.res, 400, { message: 'Unknown upload-pack command' }, { 'x-github-request-id': ctx.requestId });
}

// --------------------------------------------------------------------------- upload-pack v0

function handleUploadPackV0(ctx: GitCtx, repo: Repo): void {
  const { packets } = splitRequestBody(ctx.body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  let done = false;
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) haves.push(line.slice(5, 45));
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8, 48));
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7));
    else if (line === 'done') done = true;
  }
  void done;
  const acks: string[] = [];
  for (const h of haves) {
    if (wants.some((w) => isAncestor(repo.objects, h, w))) acks.push(h);
  }
  const parts: Buffer[] = [];
  if (acks.length) {
    for (const a of acks) parts.push(pktLine(`ACK ${a}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  const plan = planFetch(repo, { wants, haves, shallow, depth, deepenNot: [], thinPack: false, noProgress: false, ofsDelta: false, done: true });
  if (depth !== undefined) {
    for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  }
  const pack = writePack(plan.objects);
  parts.push(sidebandPack(pack));
  parts.push(PKT_FLUSH);
  sendRaw(ctx.res, 200, UPLOAD_RESULT, Buffer.concat(parts), { 'x-github-request-id': ctx.requestId });
}

// --------------------------------------------------------------------------- receive-pack v0

interface PushCommand { oldOid: string; newOid: string; ref: string; }

function handleReceivePack(ctx: GitCtx, repo: Repo): void {
  const { packets, pack } = splitRequestBody(ctx.body);
  const commands: PushCommand[] = [];
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    let line = p.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (m) commands.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
  }
  const report: string[] = [];
  if (!commands.length) {
    // No commands at all: git answers an unpack line and nothing else.
    report.push('unpack ok\n');
    const text = report.map((l) => pktLine(l)).join('');
    sendRaw(ctx.res, 200, RECEIVE_RESULT, Buffer.concat([sidebandText(Buffer.from(text, 'utf8')), PKT_FLUSH]), { 'x-github-request-id': ctx.requestId });
    return;
  }
  // Unpack the pack (when one is present). A pack is required for updates; delete-only pushes send none.
  const needsPack = commands.some((c) => c.newOid !== ZERO_OID);
  let unpackOk = true;
  let unpackDetail = 'ok';
  let incoming = new Map<string, GitObject>();
  if (needsPack) {
    if (pack.length === 0) {
      unpackOk = false;
      unpackDetail = 'unpacker error';
    } else {
      try {
        incoming = readPack(pack);
        for (const [oid, obj] of incoming) {
          if (hashObject(obj.type, obj.data) !== oid) throw new Error(`pack object ${oid} fails its hash`);
        }
      } catch (e) {
        unpackOk = false;
        unpackDetail = e instanceof Error ? e.message.slice(0, 120) : 'unpacker error';
      }
    }
  }
  report.push(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`);
  if (unpackOk) {
    for (const [oid, obj] of incoming) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    }
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          report.push(`ng ${cmd.ref} remote ref does not exist\n`);
        } else {
          repo.refs.delete(cmd.ref);
          report.push(`ok ${cmd.ref}\n`);
        }
        continue;
      }
      const target = repo.objects.get(cmd.newOid);
      // A branch points at a commit; a tag ref points at a tag (or, for a lightweight tag, a commit).
      const isTagRef = cmd.ref.startsWith('refs/tags/');
      if (!target || (!isTagRef && target.type !== 'commit') || (isTagRef && target.type !== 'tag' && target.type !== 'commit')) {
        report.push(`ng ${cmd.ref} object not found\n`);
        continue;
      }
      if (current === undefined) {
        if (cmd.oldOid !== ZERO_OID) {
          report.push(`ng ${cmd.ref} remote ref does not exist\n`);
          continue;
        }
        repo.refs.set(cmd.ref, cmd.newOid);
        report.push(`ok ${cmd.ref}\n`);
        continue;
      }
      if (current !== cmd.oldOid) {
        report.push(`ng ${cmd.ref} non-fast-forward\n`);
        continue;
      }
      // Fast-forward applies to branches (commit ancestry); a tag ref only needs the old value to match.
      if (!isTagRef && !isAncestor(repo.objects, cmd.oldOid, cmd.newOid)) {
        report.push(`ng ${cmd.ref} non-fast-forward\n`);
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      report.push(`ok ${cmd.ref}\n`);
    }
  } else {
    for (const cmd of commands) report.push(`ng ${cmd.ref} unpacker error\n`);
  }
  const text = report.map((l) => pktLine(l)).join('');
  sendRaw(ctx.res, 200, RECEIVE_RESULT, Buffer.concat([sidebandText(Buffer.from(text, 'utf8')), PKT_FLUSH]), { 'x-github-request-id': ctx.requestId });
}

// --------------------------------------------------------------------------- routing

export function routeGit(ctx: GitCtx): boolean {
  const { method, path } = ctx;
  const m = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (!m) return false;
  const owner = decodeURIComponent(m[1]);
  const repoName = decodeURIComponent(m[2]);
  const suffix = m[3] ?? '';
  if (owner !== VIEWER.login) { git404(ctx); return true; }
  const repo = ctx.store.getRepo(owner, repoName);
  if (!repo) { git404(ctx); return true; }

  if (method === 'GET' && suffix === '/info/refs') {
    const service = ctx.query.get('service');
    if (service === 'git-upload-pack') { handleInfoRefs(ctx, repo, 'git-upload-pack'); return true; }
    if (service === 'git-receive-pack') { handleInfoRefs(ctx, repo, 'git-receive-pack'); return true; }
    git404(ctx);
    return true;
  }
  if (method === 'POST' && suffix === '/git-upload-pack') {
    if (wantsV2(ctx)) handleUploadPackV2(ctx, repo);
    else handleUploadPackV0(ctx, repo);
    return true;
  }
  if (method === 'POST' && suffix === '/git-receive-pack') {
    handleReceivePack(ctx, repo);
    return true;
  }
  git404(ctx);
  return true;
}

// Re-export for tests.
export { storeObject };
