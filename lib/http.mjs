// Minimal HTTPS client for a Moodle site.
//
// Two network problems this client works around:
//
// 1. Some full-tunnel VPNs accept the TCP connection but silently drop the TLS
//    handshake. Binding the socket to the physical interface (en0/en1 on
//    macOS) bypasses the tunnel.
// 2. A server may send only its leaf certificate, signed by an intermediate
//    that is not in Node's bundled root store. Browsers and curl fetch that
//    intermediate automatically; we do the same via the certificate's AIA
//    "CA Issuers" URL and add it to the trust anchors (the root still has to
//    be a real system CA).

import https from 'node:https';
import http from 'node:http';
import tls from 'node:tls';
import os from 'node:os';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { URL, fileURLToPath } from 'node:url';

/** Site root from the environment; empty when the user has not configured one. */
export const DEFAULT_BASE = process.env.MOODLE_BASE_URL || '';

export const MISSING_SITE =
  'No Moodle site configured. Run "node cli.mjs vault init" or set MOODLE_BASE_URL.';

/** Trim whitespace and any trailing slashes from a configured site URL. */
export function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

// URLs carry credentials by accident more often than by design: a token in a pluginfile
// query string, a login/password pair in a token request. Everything written to the debug
// log passes through here first, so a query string can never reach a log file or a terminal.
const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>]+/gi;
const SECRET_PARAM = /(^|[?&\s])(?:password|passwd|pwd|token|wstoken|logintoken|secret|session|api[_-]?key)=[^&\s"'<>]*/gi;

/** Drop the userinfo and the query string from a URL. */
export function redactUrl(value) {
  try {
    const u = new URL(String(value));
    const auth = u.username || u.password ? '<redacted>@' : '';
    const query = u.search ? '?<redacted>' : '';
    return u.protocol + '//' + auth + u.host + u.pathname + query;
  } catch {
    return '<redacted-url>';
  }
}

/** Redact URLs and secret-looking parameters from any value. */
export function redact(value) {
  const text = typeof value === 'string' ? value : String(value);
  return text
    .replace(URL_IN_TEXT, (match) => redactUrl(match))
    .replace(SECRET_PARAM, (match, prefix) => prefix + '<redacted>');
}

// Query parameters that must never leave the process: they authenticate the request.
const SECRET_PARAMS = new Set([
  'password',
  'passwd',
  'pwd',
  'token',
  'wstoken',
  'logintoken',
  'secret',
  'session',
  'api_key',
  'apikey',
]);

/** Remove credential-bearing query parameters from a single URL. */
export function stripUrlSecrets(value) {
  const text = String(value);
  try {
    const u = new URL(text);
    let changed = false;
    for (const key of [...u.searchParams.keys()]) {
      if (SECRET_PARAMS.has(key.toLowerCase())) {
        u.searchParams.delete(key);
        changed = true;
      }
    }
    return changed ? u.toString() : text;
  } catch {
    return text
      .replace(
        /([?&])(?:password|passwd|pwd|token|wstoken|logintoken|secret|session|api[_-]?key)=[^&\s"'<>]*/gi,
        '$1',
      )
      .replace(/\?&/, '?')
      .replace(/[?&]$/, '');
  }
}

/**
 * Deep copy with every URL stripped of its credentials. Used for anything that leaves the
 * process: MCP tool output, the course dumps on disk, CLI --json payloads.
 */
export function scrub(value) {
  if (typeof value === 'string') {
    return value.replace(/https?:\/\/[^\s"'<>]+/g, (match) => stripUrlSecrets(match));
  }
  if (Array.isArray(value)) return value.map((item) => scrub(item));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = scrub(item);
    return out;
  }
  return value;
}

export function log(...args) {
  if (process.env.MOODLE_DEBUG) {
    process.stderr.write('[moodle] ' + args.map((a) => redact(a)).join(' ') + '\n');
  }
}

function ipv4Of(ifName) {
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (name !== ifName) continue;
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal && a.address !== '127.0.0.1') return a.address;
    }
  }
  return null;
}

/** Address of the physical interface that actually reaches the LMS. */
export function detectLocalAddress() {
  if (process.env.MOODLE_NO_BIND) return null;
  if (process.env.MOODLE_LOCAL_ADDR) return process.env.MOODLE_LOCAL_ADDR;
  return ipv4Of('en0') || ipv4Of('en1') || null;
}

const TLS_VERIFY_ERRORS = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_UNTRUSTED',
]);

// Same directory as the vault: MOODLE_SECRETS_DIR, or <repo>/.secrets by default.
const CHAIN_CACHE = path.join(
  process.env.MOODLE_SECRETS_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.secrets'),
  'tls-chain.pem',
);
const CHAIN_CACHE_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

/** Unverified handshake: learn which intermediates/AIA the server points to. */
function probeTls(host, localAddress) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host,
        port: 443,
        servername: host,
        localAddress: localAddress || undefined,
        rejectUnauthorized: false,
        ALPNProtocols: ['http/1.1'],
        timeout: 15000,
      },
      () => {
        try {
          const leaf = socket.getPeerCertificate(true);
          const intermediates = [];
          const seen = new Set();
          let node = leaf?.issuerCertificate;
          while (node && node.raw && !seen.has(node.fingerprint)) {
            seen.add(node.fingerprint);
            if (node.fingerprint !== leaf.fingerprint) intermediates.push(node.raw);
            node = node.issuerCertificate === node ? null : node.issuerCertificate;
          }
          const infoAccess = typeof leaf?.infoAccess === 'object' ? leaf.infoAccess : null;
          socket.end();
          resolve({ intermediates, infoAccess });
        } catch (err) {
          socket.destroy();
          reject(err);
        }
      },
    );
    socket.on('timeout', () =>
      socket.destroy(Object.assign(new Error('TLS probe timeout'), { code: 'ETIMEDOUT' })),
    );
    socket.on('error', reject);
  });
}

async function probeTlsSafe(host, localAddress) {
  for (const bind of [localAddress, null]) {
    try {
      return await probeTls(host, bind);
    } catch (err) {
      log('TLS probe failed', `bind=${bind || 'none'}`, err.code || err.message);
    }
  }
  return { intermediates: [], infoAccess: null };
}

function httpGetBuffer(url, localAddress, { timeout = 20000, redirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return reject(new Error(`bad url: ${redactUrl(url)}`));
    }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        localAddress: localAddress || undefined,
        agent: false,
        servername: u.protocol === 'https:' ? u.hostname : undefined,
      },
      (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
          res.resume();
          resolve(
            httpGetBuffer(new URL(res.headers.location, url).toString(), localAddress, {
              timeout,
              redirects: redirects - 1,
            }),
          );
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode} for ${redactUrl(url)}`));
          }
          resolve(Buffer.concat(chunks));
        });
        res.on('error', reject);
      },
    );
    req.setTimeout(timeout, () =>
      req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })),
    );
    req.on('error', reject);
    req.end();
  });
}

async function fetchIssuerPems(infoAccess, localAddress) {
  const uris = [];
  for (const [k, v] of Object.entries(infoAccess || {})) {
    if (!/CA Issuers/i.test(k)) continue;
    for (const uri of [].concat(v)) uris.push(String(uri));
  }
  const pems = [];
  for (const uri of uris.slice(0, 2)) {
    if (!/^https?:/i.test(uri)) continue;
    for (const bind of [localAddress, null]) {
      try {
        const der = await httpGetBuffer(uri, bind);
        const cert = new crypto.X509Certificate(der);
        if (cert.ca) pems.push(cert.toString());
        break;
      } catch (err) {
        log('AIA fetch failed', uri, `bind=${bind || 'none'}`, err.code || err.message);
      }
    }
  }
  return pems;
}

async function readChainCache() {
  try {
    const st = await fsp.stat(CHAIN_CACHE);
    if (Date.now() - st.mtimeMs > CHAIN_CACHE_MAX_AGE_MS) return [];
    const pem = await fsp.readFile(CHAIN_CACHE, 'utf8');
    return pem.includes('BEGIN CERTIFICATE') ? [pem] : [];
  } catch {
    return [];
  }
}

async function writeChainCache(pems) {
  try {
    await fsp.mkdir(path.dirname(CHAIN_CACHE), { recursive: true });
    await fsp.writeFile(CHAIN_CACHE, pems.join('\n'), 'utf8');
  } catch (err) {
    log('cannot cache chain', err.message);
  }
}

export class CookieJar {
  constructor() {
    this.cookies = new Map();
  }
  absorb(setCookie) {
    for (const line of setCookie || []) {
      const pair = String(line).split(';')[0];
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  get(name) {
    return this.cookies.get(name);
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  clear() {
    this.cookies.clear();
  }
}

function rawRequest({ url, method, headers, body, timeout, localAddress, ca }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method,
        headers,
        localAddress: localAddress || undefined,
        ca: ca || undefined,
        // Keep connections short-lived: the tunnel can change under us.
        agent: false,
        servername: u.hostname,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.setTimeout(timeout, () => {
      const err = new Error(`request timeout after ${timeout}ms`);
      err.code = 'ETIMEDOUT';
      req.destroy(err);
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export class HttpClient {
  constructor({ baseUrl = DEFAULT_BASE } = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    if (!this.baseUrl) throw new Error(MISSING_SITE);
    this.jar = new CookieJar();
    this.localAddress = detectLocalAddress();
    this.ca = null;
    this.caAttempts = 0;
  }

  url(pathOrUrl) {
    return /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : this.baseUrl + pathOrUrl;
  }

  async #buildCa({ refresh = false } = {}) {
    if (this.ca && !refresh) return this.ca;
    const host = new URL(this.baseUrl).hostname;

    let pems = refresh ? [] : await readChainCache();
    if (pems.length === 0) {
      const probe = await probeTlsSafe(host, this.localAddress);
      if (probe.intermediates.length) {
        pems = probe.intermediates.map((raw) => new crypto.X509Certificate(raw).toString());
      } else if (probe.infoAccess) {
        pems = await fetchIssuerPems(probe.infoAccess, this.localAddress);
      }
      if (pems.length) await writeChainCache(pems);
    }

    this.ca = pems.length ? [...tls.rootCertificates, ...pems] : null;
    log('trust anchors:', this.ca ? `${pems.length} extra cert(s) + system roots` : 'system roots only');
    return this.ca;
  }

  async #follow(url, { method, headers, body, timeout, maxRedirects }) {
    let current = url;
    let curMethod = method;
    let curBody = body;
    let curHeaders = { ...headers };

    for (let hop = 0; hop <= maxRedirects; hop++) {
      const sendHeaders = { ...curHeaders };
      if (this.jar.cookies.size) sendHeaders.Cookie = this.jar.header();
      if (curBody) sendHeaders['Content-Length'] = Buffer.byteLength(curBody);

      const res = await rawRequest({
        url: current,
        method: curMethod,
        headers: sendHeaders,
        body: curBody,
        timeout,
        localAddress: this.localAddress,
        ca: this.ca,
      });
      this.jar.absorb(res.headers['set-cookie']);
      log(curMethod, current, '->', res.status);

      if (REDIRECTS.has(res.status) && res.headers.location) {
        current = new URL(res.headers.location, current).toString();
        // Moodle answers the login POST with 303 See Other -> GET.
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && curMethod === 'POST')) {
          curMethod = 'GET';
          curBody = null;
          curHeaders = { ...curHeaders };
          delete curHeaders['Content-Type'];
        }
        continue;
      }
      return { status: res.status, headers: res.headers, body: res.body, url: current };
    }
    throw new Error('too many redirects');
  }

  async request(pathOrUrl, opts = {}) {
    const {
      method = 'GET',
      headers = {},
      body = null,
      timeout = 45000,
      maxRedirects = 6,
      retries = 1,
      fallback = true,
    } = opts;

    const tries = [];
    if (this.localAddress) tries.push(this.localAddress);
    if (fallback && !tries.includes(null)) tries.push(null);
    if (tries.length === 0) tries.push(null);

    let lastError;
    for (const candidate of tries) {
      this.localAddress = candidate;
      for (let attempt = 0; attempt <= retries; ) {
        try {
          return await this.#follow(this.url(pathOrUrl), {
            method,
            headers,
            body,
            timeout,
            maxRedirects,
          });
        } catch (err) {
          lastError = err;
          log('attempt failed', `bind=${candidate || 'none'}`, err.code || err.message);
          if (TLS_VERIFY_ERRORS.has(err.code) && this.caAttempts < 2) {
            this.caAttempts++;
            await this.#buildCa({ refresh: this.caAttempts > 1 });
            continue;
          }
          attempt++;
          if (attempt <= retries) await new Promise((r) => setTimeout(r, 400 * attempt));
        }
      }
    }

    const code = lastError?.code;
    const tlsProblem = TLS_VERIFY_ERRORS.has(code);
    const host = new URL(this.baseUrl).host;
    let hint;
    if (tlsProblem) {
      hint = `Cannot verify the TLS certificate of ${host}`;
    } else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      hint =
        `Cannot resolve ${host}. Check that the site URL is the Moodle root ` +
        '(https://moodle.example.edu) and that DNS works.';
    } else {
      hint =
        `Cannot reach ${host}. A full-tunnel VPN is the usual cause: it accepts the TCP ` +
        'connection but drops the TLS handshake. Try MOODLE_LOCAL_ADDR=<iface ip> or disable the VPN.';
    }
    const err = new Error(`${hint} (${lastError?.code || lastError?.message})`);
    err.cause = lastError;
    throw err;
  }

  async getText(pathOrUrl, opts = {}) {
    const res = await this.request(pathOrUrl, { ...opts, method: 'GET' });
    return { ...res, text: res.body.toString('utf8') };
  }

  async postForm(pathOrUrl, fields, opts = {}) {
    const body = new URLSearchParams(fields).toString();
    return this.request(pathOrUrl, {
      ...opts,
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(opts.headers || {}),
      },
    });
  }
}

/** Write a remote response body to disk, creating parent directories. */
export async function writeResponseToFile(res, destPath) {
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  await fsp.writeFile(destPath, res.body);
  return { path: destPath, bytes: res.body.length };
}

export const defaultHeaders = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};
