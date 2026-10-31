# AGENTS.md

Operating contract for AI agents working with this repository. Humans should read
[README.md](README.md). If you are an agent that was handed this repo (or the MCP server it ships),
this file tells you what the tools do, what they will never do, and how to recover from the errors
you will actually hit.

## 1. What this is

`moodle-mcp` exposes a Moodle site (courses, assignments, deadlines, files) over the Model Context
Protocol (stdio) and as a CLI. Both share the same library, so a workflow prototyped in the CLI works
identically through MCP tools.

- Entry point for MCP clients: `mcp-server.mjs` (stdio, JSON-RPC).
- Entry point for shells: `cli.mjs`.
- No daemon, no HTTP port, no database. Everything is per-process.

## 2. Hard invariants

1. **Read-only.** There are no tools that submit an assignment, upload a file, post to a forum or
   change a grade. Do not try to reach those endpoints by hand-editing URLs; that is outside this
   project's contract and outside the user's intent when they installed it.
2. **Never print or echo `.secrets/`.** It contains the Moodle password, a Web Services token and a
   cached TLS intermediate. Read them only through the library, never `cat` them into a transcript,
   a commit, a log or a downloaded folder.
3. **Never write credentials into `moodle-data/`.** That tree is meant to be shareable course
   material; keep secrets out of it.
4. **Quote paths.** Course, section and file names are human text with spaces, quotes and non-ASCII
   characters. Always treat returned paths as opaque strings.
5. **Do not disable TLS verification** (`NODE_TLS_REJECT_UNAUTHORIZED=0`) to "fix" a certificate
   problem. Use the AIA repair path (automatic) or report the failure.

## 3. Setup the agent can verify

```bash
node cli.mjs probe    # network: with and without the source-address bind
node cli.mjs login    # credentials + token: prints name, user id, API function count
```

If `login` prints a name, everything below works. If it fails, read the error taxonomy in §8 before
changing anything.

Credentials are file-based: `.secrets/moodle.json` with
`{ "username", "password", "baseUrl" }`, where `baseUrl` may come from `MOODLE_BASE_URL` instead.
Ask the human to create it (`bash setup-credentials.sh`) — never ask for a password in chat.

## 4. Configuration

| Variable | Default | Use |
|---|---|---|
| `MOODLE_BASE_URL` | unset (required) | Moodle site root, e.g. `https://moodle.yourschool.edu` |
| `MOODLE_TZ` | system time zone | IANA zone used for due dates |
| `MOODLE_SECRETS_DIR` | `<repo>/.secrets` | credentials + token cache |
| `MOODLE_DATA_DIR` | `<repo>/moodle-data` | downloads |
| `MOODLE_LOCAL_ADDR` | auto `en0`/`en1` | bypass a VPN tunnel |
| `MOODLE_NO_BIND` | unset | disable binding entirely |
| `MOODLE_SERVICE` | `moodle_mobile_app` | token service shortname |
| `MOODLE_DEBUG` | unset | request log on stderr (stdout stays clean for MCP) |

## 5. Identifier model

| Id | Where it comes from | Used by |
|---|---|---|
| `courseid` | `moodle_courses`, or `/course/view.php?id=N` | structure, files, dump |
| `cmid` | `id=` in any `/mod/<type>/view.php?id=N` URL | course module, assignment, download |
| `assignid` | internal assignment id (`12345`) | alternative to `cmid` + `courseid` |

A URL like `https://site/mod/assign/view.php?id=12345` gives you a **cmid**, not a course id and not
an assignment id. Resolve it with `moodle_course_module`; that call also returns the course id.

## 6. Tool contracts

All tools return a single text content block. Markdown tools are meant for humans; JSON-shaped tools
say so explicitly. Errors come back as `isError: true` with `Error: <message>`.

### `moodle_whoami`
- Arguments: none.
- Returns: `Name`, `User id`, `Site`, `API functions`, `Socket`.
- Use first when you need to confirm the session or the Moodle release.

### `moodle_courses`
- Arguments: none.
- Returns: one line per course, `` - `<id>` — <fullname> (<shortname>) ``.
- Empty result means the account has no enrolments — do not retry, report it.

### `moodle_course_structure`
- Arguments: `courseid: number` (required).
- Returns: markdown. `## <n>. <section>` headings; each module is `- <icon> **<name>** — `<modname>``
  with an optional `, due: dd.mm.yyyy hh:mm`; nested `📎 filename (size)` lines list downloadable
  files and `🔗` lines list links.
- Typical use: decide what exists before dumping gigabytes of lecture videos.

### `moodle_course_module`
- Arguments: `cmid: number` (required).
- Returns: markdown with `cmid`, `type` (`assign`, `resource`, `url`, …), `course`, optional `link`,
  and for assignments the due date plus the plain-text description.
- Fails when the id does not exist or is not visible to the account.

### `moodle_assignment`
- Arguments: `cmid` **or** (`assignid` + `courseid`).
- Returns: markdown — title, ids, due/cutoff dates, max grade, description, then a status block
  (`status: not submitted | draft | submitted`, `graded`, `can submit`, submitted filenames) and an
  `Attachments:` section where every entry carries a direct `fileurl`.
- Pass that `fileurl` verbatim to `moodle_download_file`; it already contains the access token.

### `moodle_list_files`
- Arguments: `courseid: number` (required).
- Returns: `- [size] <section> / **<filename>**` with `url: <fileurl>` on the next line.
- Only real files: pages, forums and links are not listed. Use the structure tool for those.

### `moodle_download_file`
- Arguments: `url: string` (required), `filename?: string`, `subdir?: string`.
- Returns: `Downloaded: <absolute path> (<size>)`.
- Destination is `<MOODLE_DATA_DIR>/downloads/<subdir>/<filename>`; names are sanitised.

### `moodle_dump_course`
- Arguments: `courseid: number` (required), `download?: boolean` (default `true`).
- Returns: summary with folder, section/module/file counts, failures and the `structure.md` path.
- Idempotent: files whose on-disk size already matches are skipped. Safe to re-run after a partial
  download or when a course gains new material.

## 7. CLI reference

```bash
node cli.mjs probe
node cli.mjs login
node cli.mjs site
node cli.mjs courses [--json]
node cli.mjs tree <courseid> [--json]
node cli.mjs cm <cmid> [--json]
node cli.mjs assign <cmid|assignid> 
node cli.mjs files <courseid> [--json]
node cli.mjs dump <courseid> [--no-download] [--out DIR]
```

Exit codes: `0` success, `2` missing argument, `1` runtime/auth/network error. Diagnostics go to
stderr; parse stdout only.

## 8. Error taxonomy and what to do

| Message contains | Meaning | Agent action |
|---|---|---|
| `No credentials file` | `.secrets/moodle.json` missing | ask the human to create it; do not invent credentials |
| `No Moodle site configured` | neither `MOODLE_BASE_URL` nor `baseUrl` set | ask the human for the site URL; do not guess |
| `Wrong Moodle username or password` | Moodle rejected the login/token | report; ask the human to check the account, do not loop |
| `Cannot get a token: invalidservice` | mobile Web Services disabled | report; the CLI can still fall back to the cookie flow for HTML pages |
| `invalidtoken` / `accessexception` | cached token was revoked | the client retries once automatically; if it repeats, delete `.secrets/moodle-token.json` |
| `Cannot reach <host> … ETIMEDOUT` | VPN/tunnel drops TLS | try `MOODLE_LOCAL_ADDR`, or ask the human to switch the VPN off; verify with `cli.mjs probe` |
| `Cannot verify the TLS certificate` | AIA intermediate fetch failed | delete `.secrets/tls-chain.pem`, retry on a working network |
| `HTTP 403` on a file download | token not accepted / expired | re-run `cli.mjs login`, then download again |
| `nopermissions` in a tool result | account cannot see that activity | report the limitation, do not retry other ids blindly |

Never retry a hard failure (auth, permissions) more than once; network errors may be retried twice
with a short delay.

## 9. Canonical workflows

**"What is this link?"** — a Moodle URL with `?id=N`:
`moodle_course_module(cmid=N)` → if `type` is `assign`, `moodle_assignment(cmid=N)` → attachments.

**"Show me the course material"** — `moodle_courses` → `moodle_course_structure(courseid)` →
`moodle_dump_course(courseid)` → read `moodle-data/<courseid>/structure.md`.

**"Summarise the deadlines"** — dump the course, then parse `assignments/*/assignment.json`
(`duedate`, `cutoffdate`, unix seconds) instead of re-querying each assignment.

**"Download one lecture"** — `moodle_list_files(courseid)` → `moodle_download_file(url)`.

## 10. Code map

| Path | Responsibility | Touch it when |
|---|---|---|
| `lib/http.mjs` | sockets, bind, TLS chain, cookies, redirects, retries | network/proxy/certificate behaviour |
| `lib/auth.mjs` | form login, token issue/cache, re-auth | authentication flow |
| `lib/ws.mjs` | Moodle REST calls, file download | adding a new API function |
| `lib/course.mjs` | HTML→text, outline rendering, mirroring | output format, naming, layout |
| `cli.mjs` | commands, flags, help | new CLI verb |
| `mcp-server.mjs` | tool schemas and handlers | new/modified MCP tool |

Conventions: ES modules, no build step, no runtime dependency besides `@modelcontextprotocol/sdk`;
all user-visible strings in English; secrets never interpolated into messages.

When adding a tool: add the schema to `TOOLS`, a `case` in `callTool`, a row in the README table, a
section in §6 here, and a unit test if the logic is pure.

## 11. Tests

```bash
npm test        # node --test test/ — offline, no credentials, no network
```

The suite covers HTML→text conversion, name sanitising, date/size formatting, file collection,
outline rendering and the Moodle login-token parser. Anything that needs a live Moodle belongs in
manual verification via the CLI, not in the test suite.
