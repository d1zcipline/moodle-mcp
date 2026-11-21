// Authentication: classic Moodle form login (session cookies) + Web Services token.
//
// The login, the password and the site URL are never stored in plaintext and never appear
// in logs, argv or error messages. They are sealed in the vault (lib/vault.mjs) and only
// unsealed in memory for the login exchange.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpClient, DEFAULT_BASE, MISSING_SITE, normalizeBaseUrl, log } from './http.mjs';
import { MoodleWS } from './ws.mjs';
import {
  SECRETS_DIR,
  VAULT_FILE,
  TOKEN_VAULT_FILE,
  LEGACY_CREDS,
  LEGACY_TOKEN,
  VaultError,
  readVault,
  writeVault,
  destroyVault,
  shredFile,
  describeVault,
  resolveBackend,
  backendMeta,
} from './vault.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repository root (this package). */
export const ROOT = path.resolve(here, '..');
export { SECRETS_DIR, VAULT_FILE, TOKEN_VAULT_FILE, LEGACY_CREDS, LEGACY_TOKEN };
/** Legacy plaintext path, kept as an alias so old error messages and scripts still resolve. */
export const CREDS_FILE = LEGACY_CREDS;

export const SERVICE = process.env.MOODLE_SERVICE || 'moodle_mobile_app';

export class AuthError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'AuthError';
    Object.assign(this, extra);
  }
}

const warned = new Set();

/** Print a warning to stderr once (stdout stays clean for the MCP transport). */
export function warnOnce(message) {
  if (warned.has(message)) return;
  warned.add(message);
  process.stderr.write('[moodle] ' + message + '\n');
}

/** Reject plain http:// sites: the login would travel in clear text. */
export function assertSecureSite(baseUrl) {
  const value = normalizeBaseUrl(baseUrl);
  if (!value) throw new AuthError(MISSING_SITE);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new AuthError('Not a valid site URL: ' + value);
  }
  const loopback = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i.test(parsed.hostname);
  if (parsed.protocol === 'http:' && !loopback && process.env.MOODLE_ALLOW_HTTP !== '1') {
    throw new AuthError(
      'Refusing a plain http:// site (' + parsed.origin + '): the login would be sent in clear text. ' +
        'Use https:// (set MOODLE_ALLOW_HTTP=1 only for a throwaway local server).',
    );
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new AuthError('Unsupported site URL scheme: ' + parsed.protocol);
  }
  return value;
}

/** Message shown when nothing is configured yet. */
export function credentialHelp() {
  let label = 'the platform keyring';
  try {
    const meta = backendMeta(resolveBackend());
    if (meta) label = meta.label;
  } catch {
    /* no backend available: the message below still tells the user what to do */
  }
  return (
    'No Moodle credentials stored.\n' +
    'Run:  node cli.mjs vault init\n' +
    'It asks for the site URL, login and password and seals them with ' + label + '.'
  );
}

function normalizeCreds(raw) {
  if (!raw || typeof raw !== 'object') throw new AuthError('The stored credentials are not an object');
  if (!raw.username || !raw.password) {
    throw new AuthError('The stored credentials must contain "username" and "password"');
  }
  const baseUrl = assertSecureSite(raw.baseUrl || process.env.MOODLE_BASE_URL || DEFAULT_BASE);
  return {
    username: String(raw.username).trim(),
    password: String(raw.password),
    baseUrl,
  };
}

async function loadLegacyCredentials() {
  let raw;
  try {
    raw = await readFile(LEGACY_CREDS, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  warnOnce(
    'Plaintext credentials found in ' + LEGACY_CREDS + ' - run "node cli.mjs vault migrate" ' +
      'to encrypt them and shred the file.',
  );
  try {
    return JSON.parse(raw);
  } catch {
    throw new AuthError(LEGACY_CREDS + ' is not valid JSON');
  }
}

/** Credentials from the vault (or, for one last time, from the legacy plaintext file). */
export async function loadCredentials() {
  const sealed = await readVault(VAULT_FILE);
  if (sealed) return normalizeCreds(sealed);
  const legacy = await loadLegacyCredentials();
  if (legacy) return normalizeCreds(legacy);
  throw new AuthError(credentialHelp());
}

/** Seal a validated credential object in the vault. */
export async function saveCredentials({ username, password, baseUrl }, options = {}) {
  const creds = normalizeCreds({ username, password, baseUrl });
  await writeVault(VAULT_FILE, creds, { account: 'credentials', ...options });
  return creds;
}

/** Remove the stored credentials and the cached token. */
export async function deleteCredentials() {
  await destroyVault(VAULT_FILE);
  await destroyVault(TOKEN_VAULT_FILE);
}

/** Site URL from the environment, the vault or the legacy file; empty when unset. */
export async function resolveBaseUrl() {
  const fromEnv = normalizeBaseUrl(process.env.MOODLE_BASE_URL);
  if (fromEnv) return fromEnv;
  try {
    const sealed = await readVault(VAULT_FILE);
    if (sealed && sealed.baseUrl) return normalizeBaseUrl(sealed.baseUrl);
  } catch {
    /* unreadable vault: fall through to the legacy file */
  }
  try {
    const legacy = JSON.parse(await readFile(LEGACY_CREDS, 'utf8'));
    return normalizeBaseUrl(legacy.baseUrl);
  } catch {
    return '';
  }
}

export function extractLoginToken(html) {
  const form = /<form[^>]*id="login"[\s\S]*?<\/form>/i.exec(html)?.[0] || html;
  const tag = /<input[^>]*name="logintoken"[^>]*>/i.exec(form)?.[0];
  if (!tag) return null;
  return /value="([^"]*)"/i.exec(tag)?.[1] || null;
}

function looksLoggedIn(html) {
  return /\/login\/logout\.php/.test(html);
}

/** Classic Moodle form login; returns the authenticated HTTP client. */
export async function loginWithPassword(creds) {
  const http = new HttpClient({ baseUrl: creds.baseUrl });
  const page = await http.getText('/login/index.php');
  if (looksLoggedIn(page.text)) return http;

  const logintoken = extractLoginToken(page.text);
  if (!logintoken) {
    throw new AuthError('No logintoken on the login page - the Moodle theme may have changed');
  }

  const res = await http.postForm('/login/index.php', {
    anchor: '',
    logintoken,
    username: creds.username,
    password: creds.password,
  });
  const text = res.body.toString('utf8');

  if (looksLoggedIn(text)) return http;
  if (/loginerrors|Invalid login/i.test(text)) {
    throw new AuthError('Wrong Moodle username or password');
  }
  if (!/\/login\/index\.php/.test(res.url)) return http;

  throw new AuthError('Login failed: the server returned the login form without an explicit error');
}

/**
 * Exchange the login and password for a Web Services token.
 *
 * The credentials go in the request body: a query string would end up in the Moodle
 * server access log and in every proxy log along the way.
 */
export async function fetchToken(creds) {
  const http = new HttpClient({ baseUrl: creds.baseUrl });
  const res = await http.postForm(
    '/login/token.php',
    { username: creds.username, password: creds.password, service: SERVICE },
    { timeout: 60000 },
  );
  const text = res.body.toString('utf8').trim();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new AuthError(
      'login/token.php did not return JSON (HTTP ' + res.status + '). If this site is behind a ' +
        'captive portal or a WAF, sign in with "node cli.mjs probe" first.',
    );
  }
  if (data.token) {
    await saveToken({
      token: data.token,
      baseUrl: creds.baseUrl,
      service: SERVICE,
      savedAt: new Date().toISOString(),
    });
    return data.token;
  }
  const code = data.errorcode || 'unknown';
  const hints = {
    invalidlogin: 'Wrong Moodle username or password',
    invalidservice: 'Service "' + SERVICE + '" is not available - enable the mobile service in Moodle',
    enablewsdescription: 'Web Services are disabled on this server',
    wsnotenabled: 'Web Services are disabled on this server',
  };
  throw new AuthError(hints[code] || 'Cannot get a token: ' + code + ' - ' + (data.error || ''), {
    errorcode: code,
  });
}

async function saveToken(obj) {
  await writeVault(TOKEN_VAULT_FILE, obj, { account: 'token' });
}

export async function loadCachedToken(baseUrl) {
  try {
    const data = await readVault(TOKEN_VAULT_FILE);
    if (!data || !data.token) return null;
    if (data.baseUrl && data.baseUrl !== baseUrl) return null;
    return data.token;
  } catch (err) {
    // A stale or unreadable token cache is not fatal: a fresh token replaces it.
    log('token cache ignored:', err.message);
    return null;
  }
}

export async function clearToken() {
  try {
    await destroyVault(TOKEN_VAULT_FILE);
  } catch {
    /* nothing cached */
  }
}

/**
 * Full session: credentials -> token -> wrapper.
 * Repairs an invalidated token once by re-requesting it.
 */
export async function connect({ force = false, withSiteInfo = true } = {}) {
  const creds = await loadCredentials();
  let token = force ? null : await loadCachedToken(creds.baseUrl);
  if (!token) token = await fetchToken(creds);

  const make = (tok) => {
    const http = new HttpClient({ baseUrl: creds.baseUrl });
    return { http, ws: new MoodleWS({ token: tok, baseUrl: creds.baseUrl, http }) };
  };

  let { http, ws } = make(token);
  let info = null;

  if (withSiteInfo) {
    try {
      info = await ws.siteInfo();
    } catch (err) {
      if (err.errorcode && /invalidtoken|accessexception/i.test(err.errorcode)) {
        log('token rejected, re-authenticating');
        token = await fetchToken(creds);
        ({ http, ws } = make(token));
        info = await ws.siteInfo();
      } else {
        throw err;
      }
    }
  }

  return { creds, token, http, ws, info };
}

/**
 * Encrypt the legacy .secrets/moodle.json and .secrets/moodle-token.json, verify that the
 * vault round-trips, and only then shred both plaintext files.
 */
export async function migrateLegacySecrets({ backend } = {}) {
  const summary = { credentials: false, token: false, shredded: [] };
  const legacy = await loadLegacyCredentials();

  if (legacy) {
    const creds = normalizeCreds(legacy);
    await writeVault(VAULT_FILE, creds, { account: 'credentials', backend });
    const check = await readVault(VAULT_FILE);
    if (!check || check.username !== creds.username || check.password !== creds.password) {
      throw new AuthError('Vault verification failed - ' + LEGACY_CREDS + ' was left untouched');
    }
    await shredFile(LEGACY_CREDS);
    summary.credentials = true;
    summary.shredded.push(LEGACY_CREDS);
  }

  let legacyToken = null;
  try {
    legacyToken = JSON.parse(await readFile(LEGACY_TOKEN, 'utf8'));
  } catch {
    legacyToken = null;
  }
  if (legacyToken && legacyToken.token) {
    const payload = {
      token: legacyToken.token,
      baseUrl: legacyToken.baseUrl,
      service: legacyToken.service,
      savedAt: legacyToken.savedAt,
    };
    await writeVault(TOKEN_VAULT_FILE, payload, { account: 'token', backend });
    const check = await readVault(TOKEN_VAULT_FILE);
    if (!check || check.token !== payload.token) {
      throw new AuthError('Token vault verification failed - ' + LEGACY_TOKEN + ' was left untouched');
    }
    await shredFile(LEGACY_TOKEN);
    summary.token = true;
    summary.shredded.push(LEGACY_TOKEN);
  }

  return summary;
}

/** Non-secret view of the vault for "node cli.mjs vault status". */
export async function vaultStatus() {
  const creds = await describeVault(VAULT_FILE);
  const token = await describeVault(TOKEN_VAULT_FILE);
  const legacy = [];
  for (const file of [LEGACY_CREDS, LEGACY_TOKEN]) {
    const info = await describeVault(file);
    if (info.exists) legacy.push(info.path);
  }

  let decrypt = 'empty';
  let error = null;
  if (creds.exists) {
    try {
      const obj = await readVault(VAULT_FILE);
      decrypt = obj && obj.username && obj.password ? 'ok' : 'incomplete';
    } catch (err) {
      decrypt = 'failed';
      error = err.message;
    }
  }

  let backend = null;
  let backendLabel = 'none available';
  let strong = false;
  try {
    backend = resolveBackend();
    const meta = backendMeta(backend);
    if (meta) {
      backendLabel = meta.label;
      strong = meta.strong;
    }
  } catch (err) {
    error = error || err.message;
  }

  return { creds, token, legacy, decrypt, error, backend, backendLabel, strong, secretsDir: SECRETS_DIR };
}
