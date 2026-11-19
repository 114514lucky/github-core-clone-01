// git.ts — the git object model, packfile codec and smart-HTTP protocol.
// Written from the protocol as the kit's client (program/env/src/git-client.ts) speaks it:
//   - object ids are SHA-1 over "<type> <len>\0" + data
//   - packs are v2, zlib-deflated entries, trailer SHA-1; the client sends no deltas, and this
//     server sends none either (a delta-free pack is valid; the pack-deltas check only verifies
//     that what is fetched resolves and hashes correctly)
//   - upload-pack speaks protocol v2 (ls-refs, fetch with want/have/shallow/deepen); receive-pack
//     is v0 only, with report-status + side-band-64k
// Only Node's standard library is used (node:crypto, node:zlib).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject { type: GitObjectType; data: Buffer; }
export type ObjectMap = Map<string, GitObject>;

export const ZERO_OID = '0'.repeat(40);

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export function storeObject(objects: ObjectMap, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

// --------------------------------------------------------------------------- pkt-line

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';
export interface Pkt { kind: PktKind; payload: Buffer; }

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

/** Decode a whole buffer of pkt-lines. Trailing bytes that do not form a complete line are ignored. */
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.subarray(i, i + 4).toString('ascii'), 16);
    if (Number.isNaN(len) || len < 0) break;
    if (len === 0) { out.push({ kind: 'flush', payload: Buffer.alloc(0) }); i += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim', payload: Buffer.alloc(0) }); i += 4; continue; }
    if (len === 2) { out.push({ kind: 'response-end', payload: Buffer.alloc(0) }); i += 4; continue; }
    if (i + len > buf.length) break;
    out.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return out;
}

/** Split a receive-pack / upload-pack request body into its pkt-line section and the raw pack that follows it. */
export function splitRequestBody(buf: Buffer): { packets: Pkt[]; pack: Buffer } {
  const packets: Pkt[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.subarray(i, i + 4).toString('ascii'), 16);
    if (Number.isNaN(len) || len < 0) break;
    if (len === 0) { packets.push({ kind: 'flush', payload: Buffer.alloc(0) }); i += 4; continue; }
    if (len === 1) { packets.push({ kind: 'delim', payload: Buffer.alloc(0) }); i += 4; continue; }
    if (len === 2) { packets.push({ kind: 'response-end', payload: Buffer.alloc(0) }); i += 4; continue; }
    if (i + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return { packets, pack: buf.subarray(i) };
}

/** Frame pack bytes as sideband-64k pkt-lines (band 1), each line at most 65520 bytes total. */
export function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65520 - 4 - 1;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const slice = pack.subarray(off, Math.min(pack.length, off + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.from([1])));
  return Buffer.concat(parts);
}

/** Frame a report-status text (already pkt-lined) inside sideband band 1. */
export function sidebandText(text: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65520 - 4 - 1;
  for (let off = 0; off < text.length; off += CHUNK) {
    const slice = text.subarray(off, Math.min(text.length, off + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return Buffer.concat(parts);
}

// --------------------------------------------------------------------------- commits / trees / tags

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  const view: CommitView = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) view.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) view.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) view.author = line.slice(7);
    else if (line.startsWith('committer ')) view.committer = line.slice(10);
  }
  return view;
}

export function buildCommit(v: CommitView): Buffer {
  const lines: string[] = [`tree ${v.tree}`];
  for (const p of v.parents) lines.push(`parent ${p}`);
  lines.push(`author ${v.author}`);
  lines.push(`committer ${v.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${v.message}`, 'utf8');
}

export interface TreeEntry { mode: string; name: string; oid: string; }

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const mode = data.subarray(i, sp).toString('ascii');
    const nul = data.indexOf(0, sp);
    if (nul < 0) break;
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface TagView { object: string; type: GitObjectType; tag: string; tagger: string; message: string; }

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  const view: TagView = { object: '', type: 'commit', tag: '', tagger: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) view.object = line.slice(7).trim();
    else if (line.startsWith('type ')) view.type = line.slice(5).trim() as GitObjectType;
    else if (line.startsWith('tag ')) view.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) view.tagger = line.slice(7);
  }
  return view;
}

// --------------------------------------------------------------------------- packfiles

const TYPE_CODE: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4, ofs_delta: 6, ref_delta: 7 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function readPackVarint(buf: Buffer, start: number): { size: number; type: number; next: number } {
  let i = start;
  let byte = buf[i];
  const type = (byte >> 4) & 0x7;
  let size = byte & 0x0f;
  let shift = 4;
  while (byte & 0x80) {
    i += 1;
    byte = buf[i];
    size |= (byte & 0x7f) << shift;
    shift += 7;
  }
  return { size, type, next: i + 1 };
}

/** Find the length of the zlib stream starting at `start` (inflateSync ignores trailing bytes, throws when truncated). */
function zlibStreamLength(buf: Buffer, start: number): number {
  let lo = 1;
  let hi = buf.length - start;
  // hi always succeeds (trailing bytes are ignored); binary-search the smallest succeeding length.
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      inflateSync(buf.subarray(start, start + mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return lo;
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const readVarint = (): number => {
    let out = 0;
    let shift = 0;
    for (;;) {
      const b = delta[i];
      i += 1;
      out |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return out;
  };
  const baseSize = readVarint();
  if (baseSize !== base.length) throw new Error(`delta base size ${baseSize} != ${base.length}`);
  const resultSize = readVarint();
  const chunks: Buffer[] = [];
  let total = 0;
  while (i < delta.length) {
    const op = delta[i];
    i += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let b = 0; b < 4; b += 1) if (op & (1 << b)) { offset |= delta[i] << (8 * b); i += 1; }
      for (let b = 0; b < 3; b += 1) if (op & (0x10 << b)) { size |= delta[i] << (8 * b); i += 1; }
      if (size === 0) size = 0x10000;
      chunks.push(base.subarray(offset, offset + size));
      total += size;
    } else if (op !== 0) {
      chunks.push(delta.subarray(i, i + op));
      total += op;
      i += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (total !== resultSize) throw new Error(`delta result size ${total} != ${resultSize}`);
  return Buffer.concat(chunks, total);
}

/** Parse a packfile into objects. Resolves OFS_DELTA and REF_DELTA entries. */
export function readPack(pack: Buffer): Map<string, GitObject> {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, { oid: string; type: GitObjectType; data: Buffer }>();
  const pending: Array<{ offset: number; type: number; baseOffset?: number; baseOid?: string; data: Buffer; size: number }> = [];
  let pos = 12;
  for (let n = 0; n < count; n += 1) {
    const entryOffset = pos;
    const { size, type, next } = readPackVarint(pack, pos);
    pos = next;
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (type === 6) {
      // OFS_DELTA: negative offset varint
      let byte = pack[pos];
      pos += 1;
      let off = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[pos];
        pos += 1;
        off = ((off + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = entryOffset - off;
    } else if (type === 7) {
      baseOid = pack.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    }
    const len = zlibStreamLength(pack, pos);
    const raw = inflateSync(pack.subarray(pos, pos + len));
    pos += len;
    if (raw.length !== size) throw new Error(`pack entry size ${raw.length} != ${size}`);
    if (type === 6 || type === 7) {
      pending.push({ offset: entryOffset, type, baseOffset, baseOid, data: raw, size });
    } else {
      const t = CODE_TYPE[type];
      if (!t) throw new Error(`unknown pack object type ${type}`);
      const oid = hashObject(t, raw);
      objects.set(oid, { type: t, data: raw });
      byOffset.set(entryOffset, { oid, type: t, data: raw });
    }
  }
  // Resolve deltas (bases may themselves be deltas; iterate until fixed point).
  let progress = true;
  while (pending.length && progress) {
    progress = false;
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const p = pending[i];
      let base: { type: GitObjectType; data: Buffer } | undefined;
      if (p.baseOffset !== undefined) base = byOffset.get(p.baseOffset);
      else if (p.baseOid !== undefined) base = objects.get(p.baseOid);
      if (!base) continue;
      const data = applyDelta(base.data, p.data);
      const oid = hashObject(base.type, data);
      objects.set(oid, { type: base.type, data });
      byOffset.set(p.offset, { oid, type: base.type, data });
      pending.splice(i, 1);
      progress = true;
    }
  }
  if (pending.length) throw new Error(`${pending.length} delta(s) with unresolvable base`);
  return objects;
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile v2 from plain objects (no deltas). Order: commits, trees, tags, blobs — any order is valid. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const obj of list) {
    parts.push(writePackObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Verify a packfile's trailer checksum. */
export function packChecksumOk(pack: Buffer): boolean {
  if (pack.length < 20) return false;
  const actual = pack.subarray(pack.length - 20).toString('hex');
  const expected = sha1Hex(pack.subarray(0, pack.length - 20));
  return actual === expected;
}

// --------------------------------------------------------------------------- reachability

/** BFS from roots over commits (parents), tags (object), trees (entries). Returns oid -> distance (commits only get distances; trees/blobs/tags get -1 unless reached as a commit). */
/**
 * Objects reachable from `commits` without descending past them: each commit itself plus its
 * tree and blobs (and a tag root plus its target). Parents outside the set are NOT followed —
 * this is what a depth-limited fetch sends, where the boundary commits' parents stay behind.
 */
export function collectCommitSet(objects: ObjectMap, commits: Iterable<string>): Set<string> {
  const out = new Set<string>();
  const walkTree = (oid: string): void => {
    const obj = objects.get(oid);
    if (!obj || out.has(oid)) return;
    out.add(oid);
    if (obj.type === 'tree') for (const e of parseTree(obj.data)) walkTree(e.oid);
    else if (obj.type === 'tag') walkTree(parseTag(obj.data).object);
  };
  for (const oid of commits) {
    const obj = objects.get(oid);
    if (!obj || out.has(oid)) continue;
    out.add(oid);
    if (obj.type === 'commit') walkTree(parseCommit(obj.data).tree);
    else if (obj.type === 'tag') walkTree(parseTag(obj.data).object);
  }
  return out;
}

export function collectReachable(
  objects: ObjectMap,
  roots: Iterable<string>,
  opts: { maxCommitDepth?: number } = {},
): { all: Set<string>; commitDist: Map<string, number> } {
  const all = new Set<string>();
  const commitDist = new Map<string, number>();
  const queue: Array<{ oid: string; dist: number }> = [];
  // Trees/blobs/tags reachable from a single object (a commit's tree, a tag's target).
  const walkObject = (oid: string): void => {
    const obj = objects.get(oid);
    if (!obj || all.has(oid)) return;
    all.add(oid);
    if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) walkObject(e.oid);
    } else if (obj.type === 'tag') {
      walkObject(parseTag(obj.data).object);
    }
  };
  for (const r of roots) {
    if (!r || r === ZERO_OID || all.has(r)) continue;
    const obj = objects.get(r);
    if (!obj) continue;
    if (obj.type === 'commit') { all.add(r); commitDist.set(r, 0); queue.push({ oid: r, dist: 0 }); }
    else {
      all.add(r);
      // A tag root reaches its target: a commit target joins the commit queue (its tree and
      // parents then walk normally); a non-commit target is walked as an object.
      if (obj.type === 'tag') {
        const target = parseTag(obj.data).object;
        const t = objects.get(target);
        if (t?.type === 'commit') {
          if (!commitDist.has(target)) {
            all.add(target);
            commitDist.set(target, 0);
            queue.push({ oid: target, dist: 0 });
          }
        } else if (t) {
          walkObject(target);
        }
      }
    }
  }
  while (queue.length) {
    const cur = queue.shift() as { oid: string; dist: number };
    const obj = objects.get(cur.oid);
    if (!obj || obj.type !== 'commit') continue;
    const view = parseCommit(obj.data);
    walkObject(view.tree);
    if (opts.maxCommitDepth !== undefined && cur.dist >= opts.maxCommitDepth) continue;
    for (const p of view.parents) {
      if (!commitDist.has(p) && objects.has(p)) {
        commitDist.set(p, cur.dist + 1);
        all.add(p);
        queue.push({ oid: p, dist: cur.dist + 1 });
      }
    }
  }
  return { all, commitDist };
}

/** True when `ancestor` is an ancestor of (or equal to) `descendant`. */
export function isAncestor(objects: ObjectMap, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>([descendant]);
  const queue = [descendant];
  while (queue.length) {
    const cur = queue.shift() as string;
    const obj = objects.get(cur);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (p === ancestor) return true;
      if (!seen.has(p)) { seen.add(p); queue.push(p); }
    }
  }
  return false;
}

/** Flatten a tree into path -> {oid, mode}. */
export function flattenTree(objects: ObjectMap, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const obj = objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') flattenTree(objects, e.oid, path, out);
    else out.set(path, { oid: e.oid, mode: e.mode });
  }
  return out;
}

/** Build (and store) tree objects for a flat path map. Returns the root tree oid. */
export function buildTreeFromFlat(objects: ObjectMap, flat: Map<string, { oid: string; mode: string }>): string {
  const buildDir = (prefix: string): string => {
    const entries: TreeEntry[] = [];
    const seen = new Set<string>();
    for (const [path, entry] of flat) {
      if (prefix && !path.startsWith(`${prefix}/`)) continue;
      const rest = prefix ? path.slice(prefix.length + 1) : path;
      const slash = rest.indexOf('/');
      if (slash < 0) {
        if (!seen.has(rest)) { seen.add(rest); entries.push({ mode: entry.mode, name: rest, oid: entry.oid }); }
      } else {
        const name = rest.slice(0, slash);
        if (!seen.has(name)) {
          seen.add(name);
          entries.push({ mode: '40000', name, oid: buildDir(prefix ? `${prefix}/${name}` : name) });
        }
      }
    }
    const data = buildTree(entries);
    return storeObject(objects, 'tree', data);
  };
  return buildDir('');
}

/** The flat file map of a commit (empty when the commit is unknown). */
export function commitFlat(objects: ObjectMap, commitOid: string): Map<string, { oid: string; mode: string }> {
  const obj = objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return new Map();
  return flattenTree(objects, parseCommit(obj.data).tree);
}
