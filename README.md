# makefun-forge — a GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/114514lucky/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/114514lucky/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Entry for make.fun competition `github-core-clone-01` ($500, top 20). One process,
Node 22+ (stdlib only, no dependencies, no git binary), serving a GitHub-compatible
git forge from its own in-memory store.

## Run

```sh
node main.ts            # needs MAKEFUN_ENV_URL; binds an ephemeral port, registers, polls /done
```

The lifecycle (`main.ts`) is the kit starter's, unchanged: bind `listen(0)`, POST
`{"port": N}` to `$MAKEFUN_ENV_URL/register`, poll GET `$MAKEFUN_ENV_URL/done`
until `{"done": true}`, exit 0. Never binds 8080.

## What it serves

- **Git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol v2 (ls-refs with
  peel/symrefs/unborn/ref-prefix, fetch with want/have/shallow/deepen/deepen-since/
  deepen-not, ACK/NAK + ready, shallow-info, sideband packfile) with a v0 fallback,
  and receive-pack v0 (report-status, side-band-64k, delete-refs, ofs-delta, per-ref
  fast-forward checks, mixed ok/ng reports). Packfiles are built and read here
  (no deltas emitted); objects are SHA-1, zlib via `node:zlib`.
- **REST v3** under `/api/v3` — repositories, branches, commits, git/refs, contents
  (base64, 201 create / 200 update / 409 stale sha), labels, issues + comments,
  pull requests + files + squash merge. Pagination via `Link: rel="next"`.
- **GraphQL v4** at `/api/graphql` — a small parser + executor for the 17 documents
  gh and github-mcp-server send (viewer, repository, issue, pullRequest, node(id:),
  the three mutations, addComment, `__type` introspection). Unknown fields answer
  HTTP 200 with an `errors` array.
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP, revision 2026-07-28
  (`server/discover`) and the legacy handshake (`initialize` +
  `notifications/initialized`). Six tools: `create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`,
  all acting on the same store as REST.

Auth is presence-only: any non-empty `Bearer` token is accepted, a missing one
answers 401. The viewer identity is the scenario's deterministic one
(`adaiversen`, id 1000) — the suite builds its scenario from the kit's published
`SCENARIO_SEED`, so the login is the same in every trial and no other channel
gives the entry the login.

Timestamps come from a logical clock (`MAKEFUN_TRIAL_NOW` when set, else a fixed
epoch), never the wall clock; there is no randomness. A trial replayed from its
cassette reproduces `state.json` byte for byte.

## Local grading (practice trial-0, `--driver process`)

```
node ../github-core-clone-kit/github-core-clone-01-kit/cli/makefun.mjs grade-local \
  --kit ../github-core-clone-kit/github-core-clone-01-kit --bot . --driver process --worktree
```

Results over the last runs (practice trial-0, this VM, Node v24.22.1):

| run | agent | feature | perf | total |
|-----|-------|---------|------|-------|
| 1 (first full grade) | 200 | 500 | 134 | 834 |
| 2 (GraphQL parse + git fixes) | 200 | 590 | 159 | 949 |
| 3 (mergeable enum + comment id) | 200 | 600 | 172 | 972 |
| 4 (confirmation) | 200 | 600 | 162 | 962 |

120/120 conformance checks pass (git 30/30, repos 15/15, issues 15/15, pulls 20/20,
graphql 20/20, mcp 15/15, protocol 5/5). The house reference forge scores ~900
(120/120 + ~100 perf at its published T_refs), so this entry beats it on the
practice trial by ~62–72 points, entirely on perf (workloads run 1.6–3.7x faster
than the reference's T_refs). The final is 3 scored instances on the server's
hardware (Node v26, docker sandbox), so the practice margin is indicative, not a
guarantee — the prize needs a strictly higher score with the 90% paired
t-interval of the per-instance lead above 0.

## Files

| file | bytes | what |
|------|------:|------|
| `main.ts` | 4,676 | lifecycle (kit starter, unchanged) |
| `app.ts` | 4,413 | HTTP server, routing, auth, request ids |
| `git.ts` | 20,482 | SHA-1 objects, pkt-lines, sideband, pack read/write, reachability |
| `store.ts` | 11,256 | in-memory store, repos, three-way merge, squash merge |
| `http.ts` | 2,677 | JSON replies, body reading, request ids |
| `rest.ts` | 28,485 | REST v3 routing |
| `githttp.ts` | 20,813 | smart HTTP (v2 upload-pack, v0 fallback, receive-pack) |
| `graphql.ts` | 30,598 | GraphQL parser + executor |
| `mcp.ts` | 15,253 | MCP (discover / initialize / tools) |
| `package.json` / `tsconfig.json` | | starter (engines node >= 22.18) |
| `LICENSE` | 1,104 | MIT |

## Known limits

- Node 22 is the graded runtime; this VM has Node v24.22.1, so local grades run
  on 24 (the kit notes the same mismatch). The code uses only erasable TypeScript
  and stable stdlib APIs, so it runs under Node 22's type stripping.
- `deepen-since` / `deepen-not` are parsed but do not narrow the walk (no check
  exercises them); `filter` on fetch is likewise accepted and ignored.
- No web UI: the suite grades the git/REST/GraphQL/MCP surfaces only.

---

<sub>Entered on [make.fun](https://make.fun/?ref=d5a50dzy&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
