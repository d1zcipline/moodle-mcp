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

Credentials are sealed in an encrypted vault (`.secrets/moodle.vault.json`) and are never written
to disk in plaintext. The vault uses the strongest backend the host offers:

| Host | Backend | What protects the values |
|---|---|---|
| Windows | `dpapi` | DPAPI `CurrentUser` — only this Windows account on this machine can decrypt it |
| macOS | `keychain` | a generic-password item in the login keychain |
| Linux | `secret-service` | GNOME Keyring / KWallet through `secret-tool` |
| anything else | `aes-gcm` | AES-256-GCM keyed by `MOODLE_VAULT_KEY` or a 32-byte key file (mode 600) |

```bash
node cli.mjs vault init      # asks for site URL, login and password (the password is not echoed)
node cli.mjs vault status    # backend, paths and whether plaintext is left — never the values
```

The site URL, the login, the password and the cached Web Services token all live inside the vault.
Nothing sensitive is passed on the command line, so nothing lands in the shell history or in the
process list.

`baseUrl` comes from the vault unless `MOODLE_BASE_URL` is set; there is no built-in default site.
Upgrading from a version that used `.secrets/moodle.json`: run `node cli.mjs vault migrate` — it
encrypts the plaintext files, verifies the vault and then shreds them.

Environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `MOODLE_BASE_URL` | unset (required) | Moodle site root, no trailing slash |
| `MOODLE_TZ` | system time zone | IANA zone used to render due dates |
| `MOODLE_SECRETS_DIR` | `./.secrets` | Where the vault and the TLS cache live |
| `MOODLE_VAULT_BACKEND` | auto | Force `dpapi`, `keychain`, `secret-service` or `aes-gcm` |
| `MOODLE_VAULT_KEY` | unset | Passphrase for the `aes-gcm` backend (scrypt KDF) |
| `MOODLE_ALLOW_HTTP` | unset | Set to `1` to allow a plain `http://` site (loopback always allowed) |
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
| `moodle_list_files` | `courseid` | file list with sizes and token-free `fileurl`s |
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

`.secrets/` holds the encrypted vault (site URL, login, password and the Web Services token) plus
the cached TLS intermediate. It is git-ignored, never written into `moodle-data/`, and nothing in
it is readable as text — see [Security](#security).

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Cannot reach … ETIMEDOUT` while the browser works | VPN tunnel drops TLS. `node cli.mjs probe` shows whether the bound attempt succeeds; set `MOODLE_LOCAL_ADDR=<ip>` or disable the VPN. |
| `Cannot verify the TLS certificate` | The AIA fetch failed (offline / blocked). Delete `.secrets/tls-chain.pem` and retry on a working network; the root is still verified. |
| `No Moodle credentials stored` | Run `node cli.mjs vault init` (or `setup-credentials.sh` / `setup-credentials.ps1`). |
| `No Moodle site configured` | Run `node cli.mjs vault init`, or set `MOODLE_BASE_URL` for a one-off command. |
| `Cannot decrypt the vault` / `DPAPI call failed` | The vault was copied from another machine or account. Re-run `node cli.mjs vault init`, or use `MOODLE_VAULT_BACKEND=aes-gcm` with the original `MOODLE_VAULT_KEY`. |
| `Refusing a plain http:// site` | Use `https://`; set `MOODLE_ALLOW_HTTP=1` only for a throwaway local server. |
| `Wrong Moodle username or password` | Moodle rejected the form **or** `login/token.php`. Check the account works in the browser. |
| `Cannot get a token: invalidservice` | The mobile Web Services service is disabled — ask the Moodle admin, or the client falls back to cookie mode. |
| Tools return data but file downloads 403 | The `fileurl` is token-free by design; pass it unchanged to `moodle_download_file`, which attaches the token. A 403 means the token was revoked — `node cli.mjs login`. |
| Empty `moodle_list_files` | The course may only contain pages, links and forums — check `moodle_course_structure`. |

Run `MOODLE_DEBUG=1 node cli.mjs probe` for request-level detail.

## How it works

| File | Role |
|---|---|
| `lib/http.mjs` | HTTPS client: source-address binding, AIA chain repair, cookies, redirects, retries |
| `lib/auth.mjs` | form login (`logintoken`), token issue/cache, legacy-vault migration |
| `lib/vault.mjs` | encrypted storage: DPAPI, macOS keychain, Secret Service, AES-256-GCM |
| `lib/ws.mjs` | REST wrappers (`core_course_get_contents`, `mod_assign_*`, `core_files_*`) |
| `lib/course.mjs` | HTML→text, course outline rendering, mirroring to disk |
| `cli.mjs` | command line on top of the same library |
| `mcp-server.mjs` | stdio MCP server, eight read-only tools |

The token is cached; when Moodle invalidates it the client re-authenticates once and retries the
call, so a long-running MCP server survives password rotations and session timeouts.

## Security

- The site URL, login, password and Web Services token exist only in the encrypted vault. Windows
  keeps them behind DPAPI (`CurrentUser`), macOS behind the login keychain, Linux behind the Secret
  Service; the files on disk hold ciphertext or a keyring reference, never the values.
- Everything the tool creates is restricted to the current user: `chmod 700/600` on POSIX and
  `icacls /inheritance:r /grant:r <user>:F` on Windows. That is defence in depth — the ciphertext is
  already bound to the account.
- Anything that leaves the process is cleaned first: URLs in MCP tool output, `--json` payloads
  and the `moodle-data/` dumps lose their `token` / `wstoken` / `password` parameters, so a course
  dump stays shareable and a transcript never carries a credential. The downloader re-attaches the
  token internally.
- Credentials and the token only travel in request bodies. Nothing sensitive goes into a query
  string, so it cannot leak into Moodle access logs or proxy logs, and every URL printed by
  `MOODLE_DEBUG` is stripped of its query string and userinfo before it reaches stderr.
- `node cli.mjs vault destroy --yes` removes the credentials and the token cache; revoke the token
  itself in *Moodle → Preferences → Security → Keys*.
- The client never disables certificate verification and never follows links outside the configured
  Moodle host for authentication.
- Downloads are plain HTTP GETs against `pluginfile.php` with the Web Services token attached by the client.

## License

MIT — see [LICENSE](LICENSE).

Not affiliated with Moodle Pty Ltd or any university. Use it on accounts you are allowed to use.
