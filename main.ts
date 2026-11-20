// The entry <-> env lifecycle, as env/src/wire.ts settles it: bind an ephemeral port, tell the env the
// port it bound, then poll until the env says the trial is over and exit 0. Keep this file as it is:
// the suite scores the server app.ts builds, and the lifecycle is the harness's, not the contest's.
//
//   1. MAKEFUN_ENV_URL names the env's origin (http://store:8080 in a trial container). Without it
//      there is nothing to talk to, so the program exits 1 at once.
//   2. Create the server and listen(0): the kernel picks a free port. Never bind 8080 — the env owns it.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. The env records the address the request came from
//      plus N as your base URL and dials it from then on. The first register wins; a 409 means another
//      entry already registered, and this process keeps waiting like any other.
//   4. GET $MAKEFUN_ENV_URL/done until the body is {"done": true}. The env answers at once ({"done":
//      false} while the suite runs), so this is a poll, not a long-held request. A failed or slow poll
//      is retried with a short exponential backoff; the process never exits before the env says done.
//   5. Close the server and exit 0. The harness then stops the env, which writes the export the scorer
//      reads.
//
// main.ts imports its own server and nothing else: no package, no Node built-in, no model call.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}
if (!/^https?:\/\/[^/]+/.test(ENV_URL)) {
  process.stderr.write('[entry] MAKEFUN_ENV_URL must be an http(s) origin\n');
  process.exit(1);
}

/** Read an entry tuning value from the environment, clamping it into its safe range. */
function entryEnvInt(name: string, fallback: number, low: number, high: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < low) return low;
  if (parsed > high) return high;
  return parsed;
}

/** One request may take this long before it is abandoned and retried; tunable, defaults as before. */
const REQUEST_TIMEOUT_MS = entryEnvInt('GCC_ENTRY_REQUEST_TIMEOUT_MS', 30_000, 1_000, 120_000);
/** First wait between retries, and the longest wait; tunable, defaults as before. */
const RETRY_INITIAL_MS = entryEnvInt('GCC_ENTRY_RETRY_INITIAL_MS', 250, 50, 5_000);
const RETRY_MAX_MS = entryEnvInt('GCC_ENTRY_RETRY_MAX_MS', 2_000, 250, 30_000);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The wait after `attempt` failed requests: exponential from RETRY_INITIAL_MS, capped. */
function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8));
}

/** Counters for the final summary line: how many tries each phase needed. */
let entryRegisterTries = 0;
let entryDoneTries = 0;

/** Note progress on stderr, but at most once every 25 tries so a slow env never spams the log. */
function logRetry(phase: string, attempt: number): void {
  if (attempt > 0 && attempt % 25 === 0) {
    process.stderr.write(`[entry] ${phase} still waiting after ${attempt} tries\n`);
  }
}

/** Fail fast when the tuned entry values contradict each other; defaults always pass. */
function assertEntryConfig(): void {
  if (RETRY_INITIAL_MS > RETRY_MAX_MS) throw new Error('retry initial wait exceeds retry max wait');
  if (REQUEST_TIMEOUT_MS < 1000) throw new Error('request timeout below 1000ms');
  if (RETRY_MAX_MS > 30_000) throw new Error('retry max wait above 30000ms');
}

/** One line describing the effective entry configuration, for the startup log. */
function entryConfigSummary(): string {
  return `origin=${describeOrigin(ENV_URL)} request-timeout=${REQUEST_TIMEOUT_MS}ms retry=${RETRY_INITIAL_MS}..${RETRY_MAX_MS}ms`;
}

/** The host part of an env origin, for the startup line: scheme and path stripped off. */
function describeOrigin(url: string): string {
  const rest = url.replace(/^https?:\/\//, '');
  const host = rest.split('/')[0];
  return host;
}

/** Wait until our own server answers GET /healthz, so register never races a half-started server. */
async function waitForLocalServer(port: number): Promise<void> {
  const target = `http://127.0.0.1:${port}/healthz`;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(target, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) return;
      logRetry('local-server', attempt);
    } catch {
      logRetry('local-server', attempt);
    }
    await sleep(retryDelay(attempt));
  }
}

/**
 * POST the bound port until the env accepts it. 200 is the normal answer; 409 means a first register
 * already won, which is not this process's to fix. 400 and 405 are contract errors and end the program;
 * a network error or another status is retried, since the env may still be starting.
 */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200) return;
      if (res.status === 409) {
        process.stderr.write('[entry] register answered 409: another entry registered first; waiting\n');
        return;
      }
      if (res.status === 400 || res.status === 405) throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    entryRegisterTries = attempt + 1;
    logRetry('register', attempt);
    await sleep(retryDelay(attempt));
  }
}

/** Poll GET /done until it answers {"done":true}; never return before that. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done, so poll again.
    }
    entryDoneTries = attempt + 1;
    logRetry('done', attempt);
    await sleep(retryDelay(attempt));
  }
}

/** Bound the port, register it, then wait for the env: the whole life of the process. */
async function main(): Promise<void> {
  assertEntryConfig();
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  if (address.port === 8080) throw new Error('the server bound the env port 8080 instead of an ephemeral port');
  process.stdout.write(`[entry] listening on port ${address.port}\n`);
  process.stderr.write(`[entry] config ${entryConfigSummary()}\n`);

  await waitForLocalServer(address.port);
  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
  process.stderr.write(`[entry] summary register-tries=${entryRegisterTries} done-tries=${entryDoneTries}\n`);
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
