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
screenshot/PDF/scrape APIs as MCP tools, just the job-sourcing ones below.

## Setting it up

1. Deploy this fork to Railway (see [RAILWAY.md](./RAILWAY.md)) — make sure
   `railway.json`'s `dockerfilePath` is `docker/railway/Dockerfile` (not
   `docker/chromium/Dockerfile`; that one builds from browserless.io's
   published base image, which doesn't have the MCP SDK dependency this
   endpoint needs — see the comment at the top of `docker/railway/Dockerfile`).
2. Set `TOKEN` on the Railway service (required — see RAILWAY.md).
3. In claude.ai: **Settings → Connectors → Add custom connector**, URL:

   ```
   https://<your-app>.up.railway.app/mcp?token=<TOKEN>
   ```

4. Claude will call `initialize` and `tools/list` automatically. Set up
   your candidate profile right from the chat — ask Claude to call
   `set_candidate_profile` with your name/email/etc. and `upload_resume`
   with your resume, no server filesystem access needed for either. Then
   try *"search Greenhouse for backend engineer roles at Stripe"* or
   *"what jobs have I already found?"*
5. Since Railway's disk is ephemeral, that profile won't survive a
   redeploy on its own — see "Persisting your config" below once you've
   got one you want to keep.

## The tools

| Tool | Needs a browser? | What it does |
|---|---|---|
| `list_boards` | No | Reads `job-sourcing/config/boards.json` |
| `get_candidate_profile` | No | Reads `job-sourcing/config/candidate.json` (works even if incomplete) |
| `set_candidate_profile` | No | Creates/updates the profile — partial update, merges nested fields |
| `upload_resume` | No | Uploads a resume/cover letter file, points the profile at it |
| `search_jobs` | Only for indeed/linkedin | Searches a board, records new results as "seen" |
| `list_tracked_jobs` | No | Lists jobs found so far, optionally by status |
| `get_application_questions` | Yes | Surveys a job's form — every field, no filling/screenshot/status change |
| `apply_to_job` | Yes | Autofills a Greenhouse/Lever application, returns a screenshot |
| `poll_and_apply` | Yes | Searches + autofills + (optionally) submits a batch, one call, no per-job review |

### Polling questions, then writing answers to the server

The loop for building up good `defaultAnswers` coverage before trusting
`poll_and_apply` at batch scale: **poll**, then **write**.

1. `get_application_questions({url})` (or `board`+`id`) — navigates the
   application page and reports every field: type, required, dropdown
   options, and whether the saved profile already covers it. No filling,
   no screenshot, no store status change — cheap enough to run across many
   postings just to see what they ask, before deciding anything is worth
   answering permanently.
2. For an answer worth keeping across every application on a board (not
   just this one job), write it to the server: `set_candidate_profile({
   defaultAnswers: {"Are you authorized to work in this country?": "Yes"}})`.
   That merges in — it doesn't erase whatever else was already saved.
3. Re-run `get_application_questions` on the same or another job to
   confirm those answers now show as covered, then move on to
   `apply_to_job`/`poll_and_apply` with confidence there won't be
   surprises in the skipped list.

`get_application_questions` also takes its own `answers` parameter, to
preview "if I gave these answers, would everything be covered?" without
saving anything — useful for checking a one-off answer before deciding
it's actually worth promoting to `defaultAnswers`.

### Building the candidate profile entirely through the connector

`set_candidate_profile` and `upload_resume` exist because a Railway
deployment has no filesystem access from the outside — before these, the
only way to get `job-sourcing/config/candidate.json` populated was `railway
ssh`/a volume you uploaded to by hand. Now the whole thing can happen in
chat:

1. `set_candidate_profile({fullName, email, phone, links, ...})` — every
   field is optional and calls merge rather than replace, so you can build
   it up incrementally. `get_candidate_profile` shows current progress
   (and which required fields are still missing) at any point, even before
   the profile is complete enough for `apply_to_job` to work.
2. `upload_resume({kind: "resume", filename: "resume.pdf", contentBase64:
   "..."})` — actually writes the file and points `resumePath` at it.
   `resumePath` set via `set_candidate_profile` alone is just a string;
   this is what makes it real.
3. `defaultAnswers` in `set_candidate_profile` is also how to permanently
   save answers to recurring custom questions ("are you authorized to work
   in this country?") so future applications use them automatically,
   instead of passing `answers` on every `apply_to_job`/`poll_and_apply`
   call. Setting one new question's answer merges in alongside whatever
   was already saved — it does not erase the others. For a one-off answer
   specific to a single application, prefer that call's own `answers`
   parameter instead of saving it here permanently.

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

### `poll_and_apply`: search, fill, and submit in one shot

`apply_to_job` is deliberately manual — one job at a time, with a review
step. `poll_and_apply` is the other mode: point it at a board/query and it
searches, autofills, and (with `submit: true`) submits every new match, up
to a limit, in a single call. Use this when the human has actually said to
go apply to things matching some criteria, not "show me what you'd apply
to" — that's what a plain `search_jobs` + reviewing a few `apply_to_job`
calls is for.

Since there's no human looking at each application before it sends, it
carries its own guardrails, not just the Greenhouse/Lever restriction:

- **`limit`** (default 5, hard-capped at 20 — enforced by the tool schema,
  not just convention) bounds how many applications one call can submit.
  Some boards return far more matches than that (a staffing firm's
  Greenhouse board can have 1,000+ open reqs) — `limit` is what stops a
  single call from applying to all of them.
- **Never re-applies.** A job already tracked as `applied` is skipped,
  even across separate calls — see `job-sourcing/src/store.js`'s
  `record()`, which preserves an existing status rather than resetting it
  every time a search re-touches that job.
- **Refuses to submit an incomplete application.** If any field the page
  itself marks `required` goes unanswered (profile didn't cover it, and it
  wasn't in this call's `answers`), that one job is filled and
  screenshotted but not submitted — status `needs-answers` — rather than
  sent broken. Follow up on those individually with `apply_to_job` and
  answers tailored to that specific job.
- **`submit` still defaults to `false`.** The very first call for a new
  query is worth running as a dry run — it fills and screenshots every
  match up to the limit without sending anything, so you can sanity-check
  a whole batch before trusting `submit: true` on it.

`answers` here applies to *every* job in the batch, so keep it to things
that are genuinely the same across postings (work authorization, general
availability) — not "why this company," which needs a human/Claude reading
each specific job description, which is what the manual `apply_to_job`
flow is for.

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
directory — covers config, data, and profiles together). Once it's
mounted, build the profile itself through the connector — `set_candidate_profile`
and `upload_resume` (see above) write straight onto that volume, no
`railway ssh` or manual upload needed. The volume is what makes it survive
the *next* redeploy; without one, a fresh container has an empty
`job-sourcing/config/` again and the tools will say so clearly ("no
candidate profile found") rather than fail silently.

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
