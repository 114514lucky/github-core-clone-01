// http.ts — small shared plumbing: JSON replies, body reading, request ids.
// Every reply is application/json with a non-empty X-GitHub-Request-Id header (the wire contract).

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

/** A No Content reply (default 204): no body at all. The second argument may be a status or headers. */
export function sendNoContent(
  res: ServerResponse,
  statusOrHeaders: number | Readonly<Record<string, string>> = 204,
  headers: Readonly<Record<string, string>> = {},
): void {
  const status = typeof statusOrHeaders === 'number' ? statusOrHeaders : 204;
  const hdrs = typeof statusOrHeaders === 'number' ? headers : statusOrHeaders;
  res.writeHead(status, { ...hdrs });
  res.end();
}

/** The minimal context every handler needs: the request, the response, and its id. */
export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  requestId: string;
}

export function sendRaw(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: Buffer,
  headers: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    ...headers,
  });
  res.end(body);
}

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON body; returns {ok:false} when the bytes are not a JSON object (or not JSON at all). */
export function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

export function asNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
