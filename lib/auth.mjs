// Authentication: classic Moodle form login (session cookies) + Web Services token.
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpClient, DEFAULT_BASE, MISSING_SITE, normalizeBaseUrl, log } from './http.mjs';
import { MoodleWS } from './ws.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repository root (this package). */
export const ROOT = path.resolve(here, '..');
export const SECRETS_DIR = process.env.MOODLE_SECRETS_DIR || path.join(ROOT, '.secrets');
export const CREDS_FILE = path.join(SECRETS_DIR, 'moodle.json');
export const TOKEN_FILE = path.join(SECRETS_DIR, 'moodle-token.json');

const SERVICE = process.env.MOODLE_SERVICE || 'moodle_mobile_app';

export class AuthError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'AuthError';
    Object.assign(this, extra);
  }
}

export async function loadCredentials() {
  let raw;
  try {
    raw = await readFile(CREDS_FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new AuthError(
        `No credentials file: ${CREDS_FILE}\n` +
          'Create it with the site URL, login and password:\n' +
          '  {"username": "your-login", "password": "your-password", ' +
          '"baseUrl": "https://moodle.yourschool.edu"}\n' +
          'or run: bash setup-credentials.sh',
      );
    }
    throw err;
  }
  let creds;
  try {
    creds = JSON.parse(raw);
  } catch {
    throw new AuthError(`${CREDS_FILE} is not valid JSON`);
  }
  if (!creds.username || !creds.password) {
    throw new AuthError(`${CREDS_FILE} must contain "username" and "password"`);
  }
  const baseUrl = normalizeBaseUrl(creds.baseUrl || process.env.MOODLE_BASE_URL || DEFAULT_BASE);
  if (!baseUrl) throw new AuthError(MISSING_SITE);
  return {
    username: String(creds.username).trim(),
    password: String(creds.password),
    baseUrl,
  };
}

/** Site URL from the environment or the credentials file; empty when unset. */
export async function resolveBaseUrl() {
  const fromEnv = normalizeBaseUrl(process.env.MOODLE_BASE_URL);
  if (fromEnv) return fromEnv;
  try {
    const data = JSON.parse(await readFile(CREDS_FILE, 'utf8'));
    return normalizeBaseUrl(data.baseUrl);
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
    throw new AuthError('No logintoken on the login page — the Moodle theme may have changed');
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

export async function fetchToken(creds) {
  const http = new HttpClient({ baseUrl: creds.baseUrl });
  const qs = new URLSearchParams({
    username: creds.username,
    password: creds.password,
    service: SERVICE,
  });
  const res = await http.request(`/login/token.php?${qs}`, { timeout: 60000 });
  const text = res.body.toString('utf8').trim();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new AuthError(`login/token.php did not return JSON: ${text.slice(0, 200)}`);
  }
  if (data.token) {
    await saveToken({
      token: data.token,
      baseUrl: creds.baseUrl,
      service: SERVICE,
      username: creds.username,
      savedAt: new Date().toISOString(),
    });
    return data.token;
  }
  const code = data.errorcode || 'unknown';
  const hints = {
    invalidlogin: 'Wrong Moodle username or password',
    invalidservice: `Service "${SERVICE}" is not available — enable the mobile service in Moodle`,
    enablewsdescription: 'Web Services are disabled on this server',
    wsnotenabled: 'Web Services are disabled on this server',
  };
  throw new AuthError(hints[code] || `Cannot get a token: ${code} — ${data.error || ''}`, {
    errorcode: code,
  });
}

async function saveToken(obj) {
  await mkdir(SECRETS_DIR, { recursive: true });
  await writeFile(TOKEN_FILE, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  try {
    await chmod(TOKEN_FILE, 0o600);
  } catch {
    /* best effort on exotic filesystems */
  }
}

export async function loadCachedToken(baseUrl) {
  try {
    const data = JSON.parse(await readFile(TOKEN_FILE, 'utf8'));
    if (!data.token) return null;
    if (data.baseUrl && data.baseUrl !== baseUrl) return null;
    return data.token;
  } catch {
    return null;
  }
}

export async function clearToken() {
  await writeFile(TOKEN_FILE, '{}\n', 'utf8').catch(() => {});
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
