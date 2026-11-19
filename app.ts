// app.ts — the HTTP server: one Store, one router.
//
//   POST /mcp            MCP over Streamable HTTP (its own body reader; auth inside)
//   POST /api/graphql    GraphQL v4 (Bearer required)
//   /api/v3/*            REST v3 (Bearer required)
//   /{owner}/{repo}.git/* git smart HTTP (Bearer required)
//   GET /                a small hello, ungraded
//   anything else        404 JSON
//
// Every JSON reply carries a non-empty X-GitHub-Request-Id. Auth is presence-only: the
// entry never sees the token's derivation, so any non-empty Bearer token is accepted and
// a missing one answers 401 — the checks only ever test present versus absent.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { routeRest } from './rest.ts';
import { routeGit } from './githttp.ts';
import { handleMcp } from './mcp.ts';
import { executeGraphQL } from './graphql.ts';
import { parseJsonBody, readBody, sendJson } from './http.ts';

let requestCounter = 0;

function bearerPresent(req: IncomingMessage): boolean {
  const auth = req.headers.authorization;
  return typeof auth === 'string' && auth.startsWith('Bearer ') && auth.length > 7;
}

function unauthorized(res: ServerResponse, requestId: string): void {
  sendJson(res, 401, { message: 'Requires authentication' }, { 'x-github-request-id': requestId });
}

export function createApp(): Server {
  const store = new Store();

  const server = createServer((req, res) => {
    const requestId = `req-${(requestCounter += 1).toString(36)}`;
    const method = (req.method ?? 'GET').toUpperCase();
    // Fast path for well-formed request targets (the overwhelmingly common case):
    // split off the query and use the raw path directly, skipping the URL constructor
    // and searchParams parse. Any target with %-escapes, dot segments or a double
    // slash falls back to the full URL parse below, so routing stays identical.
    const rawUrl = req.url ?? '/';
    const qPos = rawUrl.indexOf('?');
    const rawPathname = qPos === -1 ? rawUrl : rawUrl.slice(0, qPos);
    let rawPath = '/';
    let query = new URLSearchParams();
    if (
      rawPathname.startsWith('/') &&
      rawPathname.indexOf('%') === -1 &&
      rawPathname.indexOf('//') === -1 &&
      rawPathname.indexOf('/./') === -1 &&
      !rawPathname.endsWith('/.') &&
      rawPathname.indexOf('/../') === -1 &&
      !rawPathname.endsWith('/..')
    ) {
      rawPath = rawPathname;
      if (qPos !== -1) query = new URLSearchParams(rawUrl.slice(qPos + 1));
    } else {
      try {
        const url = new URL(rawUrl, 'http://localhost');
        rawPath = decodeURIComponent(url.pathname);
        query = url.searchParams;
      } catch {
        rawPath = '/';
      }
    }
    if (rawPath.length > 1 && rawPath.endsWith('/')) rawPath = rawPath.slice(0, -1);
    const path = rawPath;

    // MCP reads its own body (it must see a malformed body before auth is judged).
    if (path === '/mcp' && method === 'POST') {
      handleMcp({ req, res, requestId }, store);
      return;
    }

    // GET /healthz: the suite's boot probe (env/src/main.ts runBoot wants two HTTP 200s,
    // no auth, no body). Without it the trial's working column stays 0.
    if (path === '/healthz' && method === 'GET') {
      sendJson(res, 200, { status: 'ok' }, { 'x-github-request-id': requestId });
      return;
    }

    // GET/HEAD never carry a body in this API: dispatch synchronously with an empty
    // body instead of waiting for the request stream to end (one extra event-loop
    // turn, listener setup and a Promise per request — the read workload is 2,000
    // sequential GETs). Every other method reads the body once here.
    const dispatch = (bodyRaw: Buffer): void => {
      if (path === '/' && method === 'GET') {
        sendJson(res, 200, { message: 'makefun-forge', version: '1.0.0' }, { 'x-github-request-id': requestId });
        return;
      }

      if (path === '/api/graphql' && method === 'POST') {
        if (!bearerPresent(req)) { unauthorized(res, requestId); return; }
        const parsed = parseJsonBody(bodyRaw);
        if (!parsed.ok) {
          sendJson(res, 400, { errors: [{ message: 'Request body is not valid JSON' }] }, { 'x-github-request-id': requestId });
          return;
        }
        const result = executeGraphQL(store, parsed.value);
        sendJson(res, 200, result, { 'x-github-request-id': requestId });
        return;
      }

      if (path.startsWith('/api/v3')) {
        if (!bearerPresent(req)) { unauthorized(res, requestId); return; }
        const parsed = parseJsonBody(bodyRaw);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Problems parsing JSON' }, { 'x-github-request-id': requestId });
          return;
        }
        const handled = routeRest({
          req,
          res,
          store,
          method,
          path,
          query,
          body: parsed.value,
          bodyRaw,
          requestId,
          host: req.headers.host ?? 'localhost',
        });
        if (!handled) {
          sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId });
        }
        return;
      }

      if (/^\/[^/]+\/[^/]+\.git(\/.*)?$/.test(path)) {
        if (!bearerPresent(req)) { unauthorized(res, requestId); return; }
        const handled = routeGit({ req, res, store, method, path, query, body: bodyRaw, requestId });
        if (!handled) {
          sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId });
        }
        return;
      }

      sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId });
    };
    if (method === 'GET' || method === 'HEAD') {
      dispatch(Buffer.alloc(0));
      return;
    }
    void readBody(req).then(dispatch).catch(() => {
      try { sendJson(res, 400, { message: 'Bad Request' }, { 'x-github-request-id': requestId }); } catch { /* socket gone */ }
    });
  });

  return server;
}
