#!/usr/bin/env node
// Command line interface over the same library the MCP server uses.
import path from 'node:path';
import readline from 'node:readline';
import {
  connect,
  ROOT,
  VAULT_FILE,
  LEGACY_CREDS,
  LEGACY_TOKEN,
  saveCredentials,
  loadCredentials,
  deleteCredentials,
  migrateLegacySecrets,
  resolveBaseUrl,
  vaultStatus,
} from './lib/auth.mjs';
import { HttpClient, detectLocalAddress, MISSING_SITE, normalizeBaseUrl } from './lib/http.mjs';
import { writeVault, shredFile } from './lib/vault.mjs';
import {
  dumpCourse,
  resolveModule,
  renderStructure,
  allFiles,
  htmlToText,
  fmtDate,
  humanSize,
} from './lib/course.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0] || 'help';
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const args = argv.slice(1).filter((a) => !a.startsWith('--'));

function out(...a) {
  process.stdout.write(a.join(' ') + '\n');
}

// `cli.mjs courses | head` closes the pipe early — that is not an error.
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

function need(arg, name) {
  if (!arg) {
    out(`Missing argument: ${name}`);
    process.exit(2);
  }
  return arg;
}

async function probe() {
  const base = await resolveBaseUrl();
  if (!base) {
    out(MISSING_SITE);
    process.exit(2);
  }
  const local = detectLocalAddress();
  out(`base:        ${base}`);
  out(`bind:        ${local || 'none (MOODLE_NO_BIND?)'}`);
  const cases = [];
  if (local) cases.push(['with bind', local]);
  cases.push(['without bind', null]);
  for (const [label, bind] of cases) {
    const client = new HttpClient({ baseUrl: base });
    client.localAddress = bind;
    const started = Date.now();
    try {
      const res = await client.request('/login/index.php', {
        timeout: 20000,
        retries: 0,
        fallback: false,
      });
      out(`  ${label.padEnd(14)} HTTP ${res.status} in ${Date.now() - started} ms`);
    } catch (err) {
      out(`  ${label.padEnd(14)} error: ${err.cause?.code || err.message}`);
    }
  }
}

async function login() {
  const ctx = await connect({ force: true });
  const i = ctx.info;
  out(`✓ Signed in as ${i.fullname} (id ${i.userid})`);
  out(`  site: ${i.sitename}`);
  out(`  API functions available: ${(i.functions || []).length}`);
  out(`  socket bind: ${ctx.http.localAddress || 'none'}`);
}

async function site() {
  const ctx = await connect();
  const i = ctx.info;
  out(
    JSON.stringify(
      {
        userid: i.userid,
        fullname: i.fullname,
        sitename: i.sitename,
        release: i.release,
        functions: (i.functions || []).length,
      },
      null,
      2,
    ),
  );
}

async function courses() {
  const ctx = await connect();
  const list = await ctx.ws.courses();
  if (flags.has('--json')) return out(JSON.stringify(list, null, 2));
  out(`Courses: ${list.length}\n`);
  for (const c of list) {
    out(`  ${String(c.id).padStart(6)}  ${c.fullname}`);
    if (c.shortname) out(`          ${c.shortname}`);
  }
}

async function tree() {
  const courseid = need(args[0], 'courseid');
  const ctx = await connect();
  const list = await ctx.ws.courses();
  const course = list.find((c) => String(c.id) === String(courseid)) || {
    id: Number(courseid),
    fullname: `Course ${courseid}`,
  };
  const sections = await ctx.ws.courseContents(courseid);
  const assignments = (await ctx.ws.assignments([courseid])).flatMap((c) => c.assignments || []);
  if (flags.has('--json')) return out(JSON.stringify({ course, sections }, null, 2));
  out(renderStructure(course, sections, assignments));
}

async function cm() {
  const cmid = need(args[0], 'cmid');
  const ctx = await connect();
  const info = await resolveModule(ctx, cmid);
  if (flags.has('--json')) return out(JSON.stringify(info, null, 2));
  out(`Module ${info.cmid}: ${info.name}`);
  out(`  type:  ${info.modname}`);
  out(`  course: ${info.courseid}`);
  if (info.url) out(`  link:  ${info.url}`);
  if (info.assignment) {
    const a = info.assignment;
    out(`  due: ${fmtDate(a.duedate)}`);
    out(`  max grade: ${a.grade}`);
    const intro = htmlToText(a.intro || '');
    if (intro) out(`\n${intro}`);
    const files = [...(a.introattachments || []), ...(a.introfiles || [])];
    if (files.length) {
      out('\nAttachments:');
      for (const f of files) out(`  - ${f.filename} (${humanSize(f.filesize)})`);
    }
  }
}

async function files() {
  const courseid = need(args[0], 'courseid');
  const ctx = await connect();
  const sections = await ctx.ws.courseContents(courseid);
  const list = allFiles(sections);
  if (flags.has('--json')) return out(JSON.stringify(list, null, 2));
  out(`Files: ${list.length}\n`);
  for (const f of list) out(`  [${humanSize(f.filesize).padStart(9)}] ${f.section} / ${f.filename}`);
}

async function assign() {
  const id = need(args[0], 'cmid or assignid');
  const ctx = await connect();
  const info = await resolveModule(ctx, id);
  if (!info.assignment) {
    out(`Module ${id} is "${info.modname}", not an assignment: ${info.name}`);
    return;
  }
  out(JSON.stringify({ assignment: info.assignment, status: info.status }, null, 2));
}

async function dump() {
  const courseid = need(args[0], 'courseid');
  const outIdx = argv.indexOf('--out');
  const outDir = outIdx > -1 ? path.resolve(argv[outIdx + 1]) : path.join(ROOT, 'moodle-data', String(courseid));
  const ctx = await connect();
  out(`Dumping course ${courseid} -> ${outDir}`);
  const summary = await dumpCourse(ctx, courseid, {
    outDir,
    download: !flags.has('--no-download'),
    log: (m) => out(m),
  });
  out('');
  out(`Done: ${summary.course.fullname}`);
  out(`  sections: ${summary.sections}, modules: ${summary.modules}, assignments: ${summary.assignments.length}`);
  out(`  files: ${summary.files}, downloaded: ${summary.downloaded}, skipped: ${summary.skipped}, failed: ${summary.failed}`);
  out(`  structure: ${path.join(outDir, 'structure.md')}`);
  if (flags.has('--json')) out(JSON.stringify(summary, null, 2));
}

/* ------------------------------------------------------------------ vault */

/** Value of a "--flag value" pair, or an empty string. */
function flagValue(name) {
  const i = argv.indexOf(name);
  return i > -1 && argv[i + 1] ? argv[i + 1] : '';
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(String(answer || '').trim());
    });
  });
}

/** Ask for a secret without echoing it. */
function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = process.stdout.write.bind(process.stdout);
    rl._writeToOutput = () => {};
    write(question);
    rl.question('', (answer) => {
      rl.close();
      write('\n');
      resolve(String(answer || ''));
    });
  });
}

async function readStdinLines() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
}

/** Site, login and password from flags, environment, stdin or the terminal. */
async function collectCredentials() {
  if (argv.includes('--password')) {
    throw new Error(
      'Do not pass the password on the command line: it would land in the shell history ' +
        'and in the process list. Use the interactive prompt, MOODLE_PASSWORD, or --stdin.',
    );
  }

  let baseUrl = normalizeBaseUrl(flagValue('--base-url') || process.env.MOODLE_BASE_URL || '');
  let username = String(flagValue('--username') || process.env.MOODLE_USERNAME || '').trim();
  let password = String(process.env.MOODLE_PASSWORD || '');

  if (flags.has('--stdin')) {
    const [b, u, p] = await readStdinLines();
    baseUrl = baseUrl || normalizeBaseUrl(b);
    username = username || String(u || '').trim();
    password = password || String(p || '');
    return { baseUrl, username, password };
  }

  if (baseUrl && username && password) return { baseUrl, username, password };

  if (!process.stdin.isTTY) {
    throw new Error(
      'No terminal to prompt on. Pass --base-url and --username plus MOODLE_PASSWORD, or use --stdin.',
    );
  }

  const site = baseUrl || (await ask('Moodle site URL (https://...): '));
  const user = username || (await ask('Moodle username: '));
  const pass = password || (await askHidden('Password (not echoed): '));
  return { baseUrl: normalizeBaseUrl(site), username: user.trim(), password: pass };
}
async function vaultInit() {
  const input = await collectCredentials();
  await saveCredentials(input);
  const s = await vaultStatus();
  out('Credentials sealed with ' + s.backendLabel + '.');
  out('  vault: ' + VAULT_FILE);
  if (!s.strong) {
    out('  note:  this backend keeps the key on disk next to the vault. On Windows/macOS a');
    out('         host keyring (dpapi/keychain) is used automatically instead.');
  }

  out('Verifying the login...');
  try {
    const ctx = await connect({ force: true });
    const i = ctx.info;
    out('✓ Signed in as ' + i.fullname + ' (id ' + i.userid + ')');
    out('  site: ' + i.sitename);
    out('  API functions available: ' + (i.functions || []).length);
  } catch (err) {
    await deleteCredentials();
    throw new Error('Login failed, nothing was stored: ' + err.message);
  }
}

async function vaultStatusCmd() {
  const s = await vaultStatus();
  out('secrets dir : ' + s.secretsDir);
  out('backend     : ' + (s.backend || 'none') + ' - ' + s.backendLabel);
  out('protection  : ' + (s.strong ? 'OS keyring bound to this user account' : 'WEAK (local key file)'));
  out('');
  out(
    'credentials : ' +
      (s.creds.exists
        ? s.creds.path + ' (' + s.creds.bytes + ' B, ' + (s.creds.backend || 'unreadable') + ')'
        : 'not stored'),
  );
  out('decrypt     : ' + s.decrypt + (s.error ? ' - ' + s.error : ''));
  out('token cache : ' + (s.token.exists ? s.token.path + ' (' + s.token.bytes + ' B)' : 'not stored'));
  out(
    'legacy      : ' +
      (s.legacy.length
        ? 'PLAINTEXT PRESENT: ' + s.legacy.join(', ') + ' -> run "node cli.mjs vault migrate"'
        : 'none'),
  );
}

async function vaultMigrate() {
  const summary = await migrateLegacySecrets();
  if (!summary.credentials && !summary.token) {
    out('Nothing to migrate: no legacy plaintext files in ' + path.dirname(VAULT_FILE) + '.');
    return;
  }
  if (summary.credentials) out('✓ credentials encrypted into ' + VAULT_FILE);
  if (summary.token) out('✓ token cache encrypted next to it');
  for (const file of summary.shredded) out('✓ shredded ' + file);
  out('Run "node cli.mjs vault status" to confirm that no plaintext is left.');
}

async function vaultRotate() {
  const creds = await loadCredentials();
  const record = await writeVault(VAULT_FILE, creds, { account: 'credentials' });
  out('Re-sealed the credentials with ' + record.backend + '.');
  out('  vault: ' + VAULT_FILE);
}

async function vaultDestroy() {
  if (!flags.has('--yes')) {
    out('Refusing to delete the stored credentials without --yes.');
    out('  node cli.mjs vault destroy --yes');
    return;
  }
  await deleteCredentials();
  await shredFile(LEGACY_CREDS);
  await shredFile(LEGACY_TOKEN);
  out('Removed the vault and any legacy plaintext files.');
  out('The Web Services token itself stays valid in Moodle until you revoke it in');
  out('Preferences -> Security -> Keys.');
}

async function vault() {
  const sub = args[0] || 'status';
  switch (sub) {
    case 'init':
      return vaultInit();
    case 'status':
      return vaultStatusCmd();
    case 'migrate':
      return vaultMigrate();
    case 'rotate':
      return vaultRotate();
    case 'destroy':
      return vaultDestroy();
    default:
      out('Unknown vault command: ' + sub);
      return out('  node cli.mjs vault init|status|migrate|rotate|destroy');
  }
}
const HELP = [
  'Moodle CLI',
  '',
  '  node cli.mjs probe                 check connectivity (bypasses a full-tunnel VPN)',
  '  node cli.mjs login                 sign in and print the profile',
  '  node cli.mjs site                  site info and number of API functions',
  '  node cli.mjs courses               list my courses',
  '  node cli.mjs tree <courseid>       course structure as markdown',
  '  node cli.mjs cm <cmid>             one module by the id= from a Moodle URL',
  '  node cli.mjs assign <cmid|id>      full assignment JSON',
  '  node cli.mjs files <courseid>      list course files',
  '  node cli.mjs dump <courseid> [--no-download] [--out DIR]   save the whole course',
  '',
  '  node cli.mjs vault init            ask for site/login/password, store them encrypted',
  '  node cli.mjs vault status          which backend protects the vault (never the values)',
  '  node cli.mjs vault migrate         encrypt legacy plaintext files, then shred them',
  '  node cli.mjs vault rotate          re-seal the vault with the current backend or key',
  '  node cli.mjs vault destroy --yes   delete the stored credentials and the token cache',
  '',
  '  Flags: --json, --no-download, --out DIR, --base-url URL, --username NAME, --stdin',
  '  Env: MOODLE_BASE_URL, MOODLE_TZ, MOODLE_LOCAL_ADDR, MOODLE_NO_BIND=1, MOODLE_SECRETS_DIR,',
  '       MOODLE_SERVICE, MOODLE_VAULT_BACKEND, MOODLE_VAULT_KEY, MOODLE_USERNAME, MOODLE_PASSWORD,',
  '       MOODLE_ALLOW_HTTP=1, MOODLE_DEBUG=1',
  '  Credentials: encrypted vault at ' + VAULT_FILE,
].join('\n');

async function main() {
  switch (cmd) {
    case 'probe':
      return probe();
    case 'login':
      return login();
    case 'site':
      return site();
    case 'courses':
      return courses();
    case 'tree':
      return tree();
    case 'cm':
      return cm();
    case 'assign':
      return assign();
    case 'files':
      return files();
    case 'dump':
      return dump();
    case 'vault':
      return vault();
    case 'help':
    case '--help':
    case '-h':
      return out(HELP);
    default:
      out(`Unknown command: ${cmd}\n`);
      return out(HELP);
  }
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  if (process.env.MOODLE_DEBUG && err.stack) process.stderr.write(err.stack + '\n');
  process.exit(1);
});
