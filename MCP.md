# MCP: job-sourcing as a claude.ai custom connector

This fork exposes the [`job-sourcing/`](./job-sourcing) toolkit as an MCP
(Model Context Protocol) endpoint — `POST /mcp` — built directly into the
Browserless server itself (`src/routes/management/http/mcp.post.ts`). That's
deliberate: it means one Railway deployment gives you both the browser
server *and* a conversational connector for it, with no second service to
run, deploy, or pay for.

If you just want the CLI, you don't need any of this — see
[JOB_SOURCING.md](./JOB_SOURCING.md) instead. This doc is specifically for
driving job search/apply from Claude via a custom connector.

## What it's not

This is **not** browserless.io's paid "MCP Server" cloud product (mentioned
in the main [README.md](./README.md)'s Premium Features). That's a separate,
hosted offering tied to a browserless.io cloud account. This is a small,
self-hosted MCP endpoint this fork adds on top of the open-source server,
purpose-built for job-sourcing — it doesn't expose Browserless's general
screenshot/PDF/scrape APIs as MCP tools, just the five job-sourcing ones
below.

## Setting it up

1. Deploy this fork to Railway (see [RAILWAY.md](./RAILWAY.md)) — make sure
   `railway.json`'s `dockerfilePath` is `docker/railway/Dockerfile` (not
   `docker/chromium/Dockerfile`; that one builds from browserless.io's
   published base image, which doesn't have the MCP SDK dependency this
   endpoint needs — see the comment at the top of `docker/railway/Dockerfile`).
2. Set `TOKEN` on the Railway service (required — see RAILWAY.md).
3. Put your candidate profile and boards config where the *server* can read
   them: `job-sourcing/config/candidate.json` and `job-sourcing/config/boards.json`
   inside the running container. Since Railway's disk is ephemeral, attach a
   volume (see "Persisting your config" below) rather than expecting these
   to survive a redeploy on their own.
4. In claude.ai: **Settings → Connectors → Add custom connector**, URL:

   ```
   https://<your-app>.up.railway.app/mcp?token=<TOKEN>
   ```

5. Claude will call `initialize` and `tools/list` automatically. Try asking
   something like *"search Greenhouse for backend engineer roles at Stripe"*
   or *"what jobs have I already found?"*

## The tools

| Tool | Needs a browser? | What it does |
|---|---|---|
| `list_boards` | No | Reads `job-sourcing/config/boards.json` |
| `get_candidate_profile` | No | Reads `job-sourcing/config/candidate.json` |
| `search_jobs` | Only for indeed/linkedin | Searches a board, records new results as "seen" |
| `list_tracked_jobs` | No | Lists jobs found so far, optionally by status |
| `apply_to_job` | Yes | Autofills a Greenhouse/Lever application, returns a screenshot |

`apply_to_job` doesn't require going through `search_jobs` first — pass it
a `url` directly (a `boards.greenhouse.io`, `job-boards.greenhouse.io`, or
`jobs.lever.co` link) and it'll apply to that listing on the spot. That's
the same allowlist `search_jobs`'s auto-apply support is restricted to, for
the ToS reasons above — a LinkedIn or Indeed URL passed as `url` is
rejected with an explanatory error, not silently attempted. Prefer
`board`+`id` (from a prior `search_jobs`/`list_tracked_jobs` call) when
you have it; `url` is for a listing found outside this toolkit.

`search_jobs` and `apply_to_job` that need a browser connect to *this same
Browserless instance* over a loopback WebSocket (`ws://127.0.0.1:<port>`) —
see `src/mcp/job-sourcing.ts`. No external Browserless dependency, no second
deployment.

### `apply_to_job` is deliberately two-step

Call it once with the default `submit: false` (or just omit it) — it fills
the form, screenshots it, and returns that screenshot inline in the chat as
an image. Only call it again with `submit: true` after you (a human) have
actually looked at that screenshot and are OK with what it's about to send.
Never have Claude chain straight from `apply_to_job(submit:false)` to
`apply_to_job(submit:true)` without a real review in between — that defeats
the entire point of the dry-run step. See JOB_SOURCING.md's
[Ethics & Terms of Service](./JOB_SOURCING.md#ethics--terms-of-service)
section for why auto-apply is Greenhouse/Lever-only in the first place.

### The candidate profile can't answer everything — that's what `answers` is for

`config/candidate.json` reliably covers the fields every application shares
(name, email, resume upload, standard links). It can't anticipate a given
company's custom screening questions — "why do you want to work here?",
role-specific technical questions, a salary figure tailored to *this* role.
Rather than guess, `apply_to_job` reports those as `skipped`, each with its
field type and (for dropdowns) its options, so you — or Claude, reading the
job description and company context — can compose a real answer:

1. Call `apply_to_job` once with just `url` (or `board`+`id`). Read the
   `skipped` list in the response.
2. Call it again, same target, with `answers` — an object keyed by the
   *exact* field label from step 1's skipped list, e.g.
   `{"Why do you want to work here?": "..."}`. Still leave `submit` off;
   review the new screenshot to confirm those answers actually landed
   correctly (a dropdown especially — it's matched by option text, and
   worth confirming the right one got selected).
3. Only then call it a third time with `submit: true`.

`answers` always wins over anything the static profile would have matched
for the same field, so it's also how to override a profile default for one
specific application (a different desired-start-date for a role with an
unusual notice period, say) without editing `candidate.json`.

## Persisting your config

Two things need to survive a Railway redeploy:

1. **Candidate profile & boards config** (`job-sourcing/config/candidate.json`,
   `job-sourcing/config/boards.json`) — these aren't baked into the image
   (see `.dockerignore`), so on a fresh container they won't exist and the
   tools will return a clear "no candidate profile found" error telling you
   to create them.
2. **Job-board login profiles** (for the indeed/linkedin adapters) — see
   RAILWAY.md's "Persisting job-board logins" section.

Attach a Railway volume mounted at `/usr/src/app/job-sourcing` (the whole
directory — covers config, data, and profiles together) and either:

- upload `candidate.json`/`boards.json` onto that volume once (e.g. via
  `railway ssh` or a one-off `railway run` command), or
- ask Claude to write them for you through the connector — there isn't a
  dedicated MCP tool for this today, so that means asking it to run
  something like a `/function` call that writes the file, or doing it via
  `railway ssh` yourself. A dedicated `set_candidate_profile` tool would be
  a reasonable follow-up if this comes up often.

## Stateless mode, and why GET/DELETE return 405

`POST /mcp` runs the MCP TypeScript SDK's `StreamableHTTPServerTransport`
in **stateless** mode (`sessionIdGenerator: undefined`): every request gets
a fresh `McpServer` instance, and the response is a single JSON reply, not
a held-open SSE stream. That's why `GET /mcp` and `DELETE /mcp` — which the
Streamable HTTP spec reserves for opening/closing a server-initiated SSE
stream and terminating a session — both return 405: there's no session to
resume or close. This is spec-compliant (405 is exactly what a client
should see when a server doesn't offer that), and it keeps the endpoint
simple: no in-memory session state to leak or clean up across Railway's
request routing.

## A note on content-type matching

If you're extending this endpoint (or debugging a "route not found" error),
know that this framework's router matches a route's `contentTypes` field
against the client's `Accept` header *literally* — `contentTypes.any` (`*/*`)
only matches if the client sends `Accept: */*` verbatim. MCP clients always
send `Accept: application/json, text/event-stream`, which doesn't contain
`*/*`, so the route declares `contentTypes = [contentTypes.json]` (matching
the `application/json` term) rather than `contentTypes.any`. See the comment
in `mcp.post.ts` and `src/router.ts`'s `getRouteForHTTPRequest` if you want
the full mechanics.
