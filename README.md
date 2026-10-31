# moodle-mcp

MCP server and CLI for [Moodle](https://moodle.org/): read courses, assignments, deadlines and files
from the terminal or straight from an AI agent — no browser automation, no scraping of interactive
pages in the common case.

It talks to the official Moodle **Web Services** API (`core_course_get_contents`,
`mod_assign_get_assignments`, …), falls back to the session-cookie HTML flow when a site restricts
the mobile service, and works around two network problems that break naive clients.

```
$ node cli.mjs courses
     101  Introduction to Data Engineering
     102  Academic English

$ node cli.mjs cm 12345
Module 12345: Example practical task
  type:  assign
  course: 101
  due: —
  max grade: 5
```

## Why this exists

Two things go wrong on some networks, and both are handled automatically:

1. **A full-tunnel VPN kills TLS, not TCP.** The tunnel completes the TCP handshake and then
   silently drops the `ClientHello`, so every request ends in `ETIMEDOUT` even though `nc` says the
   port is open. The client binds its sockets to the physical interface (`en0`/`en1` on macOS,
   overridable with `MOODLE_LOCAL_ADDR`) instead of the tunnel and the site answers in ~400 ms.
   Browsers are usually unaffected because their traffic is shaped differently — so "it works in my
   browser" does not mean a script can reach it.
2. **The server sends an incomplete certificate chain.** Only the leaf is returned, signed by an
   intermediate that is not in Node's bundled root store (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`), while
   curl and browsers quietly fetch the missing link. The client reads the AIA "CA Issuers" URL from
   the leaf, downloads that intermediate, caches it in `.secrets/tls-chain.pem` and keeps validating
   against the real system roots — no `NODE_TLS_REJECT_UNAUTHORIZED=0` anywhere.

Both workarounds are no-ops on a normal network: binding falls back to a plain connection, and the
chain is only fetched when Node actually complains about it.

## Requirements

- Node.js **18 or newer**
- An account on a Moodle site with Web Services enabled (the standard `moodle_mobile_app` service —
  most universities have it for the mobile app) and, preferably, the
  [Moodle mobile service](https://docs.moodle.org/en/Web_services) enabled for your role.

## Install

```bash
git clone https://github.com/d1zcipline/moodle-mcp.git
cd moodle-mcp
npm ci                 # or: npm install
```

## Configure

Credentials live in `.secrets/moodle.json` (mode `600`):

```json
{
  "username": "your-login",
  "password": "your-password",
  "baseUrl": "https://moodle.yourschool.edu"
}
```

The easy way:

```bash
bash setup-credentials.sh     # prompts for site URL and login, hides the password
```

`baseUrl` is required unless `MOODLE_BASE_URL` is set — there is no built-in default site.
Environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `MOODLE_BASE_URL` | unset (required) | Moodle site root, no trailing slash |
| `MOODLE_TZ` | system time zone | IANA zone used to render due dates |
| `MOODLE_SECRETS_DIR` | `./.secrets` | Where `moodle.json` and the token cache live |
| `MOODLE_DATA_DIR` | `./moodle-data` | Where downloaded course material goes |
| `MOODLE_LOCAL_ADDR` | auto (`en0`, `en1`) | Source address to bypass a VPN tunnel |
| `MOODLE_NO_BIND` | unset | Set to `1` to never bind a source address |
| `MOODLE_SERVICE` | `moodle_mobile_app` | Web Services shortname used for the token |
| `MOODLE_DEBUG` | unset | Set to `1` for request-level logs on stderr |

## CLI

```bash
node cli.mjs probe                 # is the site reachable at all, with and without the bind
node cli.mjs login                 # sign in, print name and available API functions
node cli.mjs courses               # my courses
node cli.mjs tree <courseid>       # course outline as markdown
node cli.mjs cm <cmid>             # one module by id= from a Moodle URL
node cli.mjs assign <cmid>         # assignment JSON incl. submission status
node cli.mjs files <courseid>      # every downloadable file
node cli.mjs dump <courseid>       # mirror the whole course into ./moodle-data/<courseid>
```

`dump` writes `structure.md`, `course.json`, `summary.json`, every course file under `files/`, and
one folder per assignment with its description and attachments. Re-running it skips files whose
size already matches, so it is cheap to repeat. Flags: `--json`, `--no-download`, `--out DIR`.

## MCP

The server speaks stdio and exposes eight read-only tools.

DeepSeek Harness (`~/.dsh/profiles/desktop/cordis.patch.yml`):

```yaml
- insert:
    - id: mcp-moodle
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: moodle
        transport: stdio
        command: node
        args: [/absolute/path/to/moodle-mcp/mcp-server.mjs]
        cwd: /absolute/path/to/moodle-mcp
        failOnStartupError: false
```

Claude Desktop (`claude_desktop_config.json`) and most other clients:

```json
{
  "mcpServers": {
    "moodle": {
      "command": "node",
      "args": ["/absolute/path/to/moodle-mcp/mcp-server.mjs"],
      "env": { "MOODLE_BASE_URL": "https://moodle.yourschool.edu" }
    }
  }
}
```

Ready-to-copy files are in [`examples/`](examples).

### Tools

| Tool | Arguments | Returns |
|---|---|---|
| `moodle_whoami` | — | name, user id, site release, number of API functions |
| `moodle_courses` | — | `id — fullname (shortname)` list |
| `moodle_course_structure` | `courseid` | markdown outline with due dates and files |
| `moodle_course_module` | `cmid` | module name/type/course, assignment due date and description |
| `moodle_assignment` | `cmid` or `assignid`+`courseid` | description, dates, grade, attachments, submission status |
| `moodle_list_files` | `courseid` | file list with sizes and `fileurl`s |
| `moodle_download_file` | `url`, `filename?`, `subdir?` | saved path and size |
| `moodle_dump_course` | `courseid`, `download?` | mirror of the whole course on disk |

There are deliberately **no** submission or upload tools: an agent can read everything and change
nothing in Moodle.

## What it stores

```
moodle-data/<courseid>/
  structure.md                  human-readable course outline
  course.json                   raw sections/modules from the API
  summary.json                  what was downloaded into this folder
  files/<section>/<file>        course files
  assignments/<cmid>-<name>/
    intro.md                    description, dates, grade, attachments
    assignment.json             raw assignment + submission status
    files/<file>                attachments
```

`.secrets/` holds the credentials, the Web Services token and the cached TLS intermediate — all of
it is git-ignored and never written into `moodle-data/`.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Cannot reach … ETIMEDOUT` while the browser works | VPN tunnel drops TLS. `node cli.mjs probe` shows whether the bound attempt succeeds; set `MOODLE_LOCAL_ADDR=<ip>` or disable the VPN. |
| `Cannot verify the TLS certificate` | The AIA fetch failed (offline / blocked). Delete `.secrets/tls-chain.pem` and retry on a working network; the root is still verified. |
| `No credentials file` | Create `.secrets/moodle.json` or run `bash setup-credentials.sh`. |
| `No Moodle site configured` | Set `MOODLE_BASE_URL` or add `"baseUrl"` to `.secrets/moodle.json`. |
| `Wrong Moodle username or password` | Moodle rejected the form **or** `login/token.php`. Check the account works in the browser. |
| `Cannot get a token: invalidservice` | The mobile Web Services service is disabled — ask the Moodle admin, or the client falls back to cookie mode. |
| Tools return data but file downloads 403 | The `fileurl` already carries a token; pass it unchanged instead of editing the URL. |
| Empty `moodle_list_files` | The course may only contain pages, links and forums — check `moodle_course_structure`. |

Run `MOODLE_DEBUG=1 node cli.mjs probe` for request-level detail.

## How it works

| File | Role |
|---|---|
| `lib/http.mjs` | HTTPS client: source-address binding, AIA chain repair, cookies, redirects, retries |
| `lib/auth.mjs` | form login (`logintoken`) and Web Services token, cached in `.secrets` |
| `lib/ws.mjs` | REST wrappers (`core_course_get_contents`, `mod_assign_*`, `core_files_*`) |
| `lib/course.mjs` | HTML→text, course outline rendering, mirroring to disk |
| `cli.mjs` | command line on top of the same library |
| `mcp-server.mjs` | stdio MCP server, eight read-only tools |

The token is cached; when Moodle invalidates it the client re-authenticates once and retries the
call, so a long-running MCP server survives password rotations and session timeouts.

## Security

- The password is only read from `.secrets/moodle.json` (mode `600`) and is never logged, printed or
  written into course dumps.
- The Web Services token is stored next to it with the same permissions; delete the file to revoke
  local access, and revoke the token itself in *Moodle → Preferences → Security → Keys*.
- The client never disables certificate verification and never follows links outside the configured
  Moodle host for authentication.
- Downloads are plain HTTP GETs against `pluginfile.php` with the token embedded by Moodle.

## License

MIT — see [LICENSE](LICENSE).

Not affiliated with Moodle Pty Ltd or any university. Use it on accounts you are allowed to use.
