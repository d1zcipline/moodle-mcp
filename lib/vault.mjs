// Encrypted storage for the Moodle login, password, site URL and Web Services token.
//
// Nothing is written to disk in plaintext. The payload is sealed by the strongest
// backend the host offers:
//
//   dpapi           Windows Data Protection API, CurrentUser scope. The ciphertext is
//                   bound to this Windows account on this machine: another user, another
//                   PC or a copied folder cannot open it without that account profile.
//   keychain        macOS login keychain (generic password item, read back by name).
//   secret-service  Linux Secret Service via secret-tool (GNOME Keyring, KWallet bridge).
//   aes-gcm         Portable fallback: AES-256-GCM with a key from MOODLE_VAULT_KEY or a
//                   32-byte key file in the secrets directory. That key file is mode 600
//                   and ACL-restricted, but it lives next to the vault, so treat this as
//                   protection against accidental copying, not against a local attacker
//                   who already runs as you. It is only used when no OS keyring exists.
//
// The vault file is a small JSON record. For the OS keyring backends it holds only the
// reference to the keyring item; for dpapi/aes-gcm it holds ciphertext. Either way the
// file is useless on another machine and under another user account.

import { spawnSync } from 'node:child_process';
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Directory that holds the vault, the legacy plaintext files and the TLS cache. */
export const SECRETS_DIR = process.env.MOODLE_SECRETS_DIR || path.join(ROOT, '.secrets');
/** Encrypted credentials (username, password, baseUrl). */
export const VAULT_FILE = path.join(SECRETS_DIR, 'moodle.vault.json');
/** Encrypted Web Services token cache. */
export const TOKEN_VAULT_FILE = path.join(SECRETS_DIR, 'moodle-token.vault.json');
/** Legacy plaintext files - read once for migration, then shredded. */
export const LEGACY_CREDS = path.join(SECRETS_DIR, 'moodle.json');
export const LEGACY_TOKEN = path.join(SECRETS_DIR, 'moodle-token.json');
/** AES-256-GCM key file, only used by the portable fallback backend. */
export const KEY_FILE = path.join(SECRETS_DIR, 'vault.key');

const KEYCHAIN_SERVICE = 'moodle-mcp';
const KEYCHAIN_ACCOUNT = 'credentials';

export class VaultError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'VaultError';
    Object.assign(this, extra);
  }
}

const BACKENDS = {
  dpapi: {
    strong: true,
    label: 'Windows DPAPI (current user, this machine)',
    available: () => process.platform === 'win32',
  },
  keychain: {
    strong: true,
    label: 'macOS login keychain',
    available: () => process.platform === 'darwin' && commandExists('security'),
  },
  'secret-service': {
    strong: true,
    label: 'Linux Secret Service (secret-tool)',
    available: () => process.platform === 'linux' && commandExists('secret-tool'),
  },
  'aes-gcm': {
    strong: false,
    label: 'AES-256-GCM with a local key file (portable fallback)',
    available: () => true,
  },
};

const BACKEND_ORDER = ['dpapi', 'keychain', 'secret-service', 'aes-gcm'];

function commandExists(cmd) {
  if (process.platform === 'win32') return false;
  const res = spawnSync('/bin/sh', ['-c', 'command -v ' + cmd], { encoding: 'utf8', timeout: 10000 });
  return res.status === 0 && String(res.stdout || '').trim() !== '';
}

/** Backends usable on this host, strongest first. */
export function availableBackends() {
  return BACKEND_ORDER.filter((name) => BACKENDS[name].available());
}

/** Backend that will be used: MOODLE_VAULT_BACKEND when set, otherwise the strongest host backend. */
export function resolveBackend(explicit) {
  const wanted = String(explicit || process.env.MOODLE_VAULT_BACKEND || '').trim();
  if (wanted) {
    if (!BACKENDS[wanted]) {
      throw new VaultError(
        'Unknown vault backend "' + wanted + '". Use one of: ' + BACKEND_ORDER.join(', ') + '.',
      );
    }
    if (!BACKENDS[wanted].available()) {
      throw new VaultError('Vault backend "' + wanted + '" is not available on this host.');
    }
    return wanted;
  }
  return availableBackends()[0];
}

export function backendMeta(name) {
  const meta = BACKENDS[name];
  return meta ? { name, strong: meta.strong, label: meta.label } : null;
}

/* ------------------------------------------------------------------ DPAPI */

const PS_PREFIX =
  "$ErrorActionPreference='Stop';" +
  'Add-Type -AssemblyName System.Security;' +
  '$in=[Console]::In.ReadToEnd().Trim();' +
  '$bytes=[Convert]::FromBase64String($in);';

const PS_PROTECT =
  PS_PREFIX +
  '$out=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,' +
  '[System.Security.Cryptography.DataProtectionScope]::CurrentUser);' +
  '[Console]::Out.Write([Convert]::ToBase64String($out));';

const PS_UNPROTECT =
  PS_PREFIX +
  '$out=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,' +
  '[System.Security.Cryptography.DataProtectionScope]::CurrentUser);' +
  '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($out));';

function runPowerShell(script, input) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];
  const opts = { input, encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 16 * 1024 * 1024 };
  let res = spawnSync(process.platform === 'win32' ? 'powershell.exe' : 'pwsh', args, opts);
  if (res.error && res.error.code === 'ENOENT') res = spawnSync('pwsh', args, opts);
  if (res.error) {
    throw new VaultError(
      'Cannot start PowerShell for the DPAPI backend (' + res.error.message + '). ' +
        'Set MOODLE_VAULT_BACKEND=aes-gcm to use the portable backend instead.',
    );
  }
  if (res.status !== 0) {
    const detail = String(res.stderr || '').trim().split(String.fromCharCode(10)).filter(Boolean).slice(-1).join(' ');
    throw new VaultError('DPAPI call failed: ' + (detail || 'unknown error'));
  }
  return String(res.stdout || '').trim();
}

function dpapiProtect(plain) {
  return Buffer.from(runPowerShell(PS_PROTECT, plain.toString('base64')), 'base64');
}

function dpapiUnprotect(blob) {
  return Buffer.from(runPowerShell(PS_UNPROTECT, Buffer.from(blob).toString('base64')), 'utf8');
}

/* ------------------------------------------------------------ OS keyrings */

function keychainStore(account, secret) {
  const res = spawnSync(
    'security',
    ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'],
    { input: secret, encoding: 'utf8', timeout: 30000 },
  );
  if (res.error || res.status !== 0) {
    throw new VaultError(
      'Cannot write to the macOS keychain: ' +
        ((res.error && res.error.message) || String(res.stderr || '').trim()),
    );
  }
}

function keychainLoad(account) {
  const res = spawnSync(
    'security',
    ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'],
    { encoding: 'utf8', timeout: 30000 },
  );
  if (res.error || res.status !== 0) {
    throw new VaultError(
      'No keychain item for ' + KEYCHAIN_SERVICE + '/' + account +
        ': run "node cli.mjs vault init" again',
    );
  }
  return String(res.stdout || '').replace(/\r?\n$/, '');
}

function keychainDelete(account) {
  spawnSync('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account], {
    encoding: 'utf8',
    timeout: 30000,
  });
}

function secretToolStore(account, secret) {
  const res = spawnSync(
    'secret-tool',
    ['store', '--label', KEYCHAIN_SERVICE + ' ' + account, 'service', KEYCHAIN_SERVICE, 'account', account],
    { input: secret, encoding: 'utf8', timeout: 30000 },
  );
  if (res.error || res.status !== 0) {
    throw new VaultError(
      'Cannot write to the Secret Service: ' +
        ((res.error && res.error.message) || String(res.stderr || '').trim()),
    );
  }
}

function secretToolLoad(account) {
  const res = spawnSync('secret-tool', ['lookup', 'service', KEYCHAIN_SERVICE, 'account', account], {
    encoding: 'utf8',
    timeout: 30000,
  });
  if (res.error || res.status !== 0 || !String(res.stdout || '').trim()) {
    throw new VaultError(
      'No Secret Service entry for ' + KEYCHAIN_SERVICE + '/' + account +
        ': run "node cli.mjs vault init" again',
    );
  }
  return String(res.stdout || '').replace(/\r?\n$/, '');
}

function secretToolDelete(account) {
  spawnSync('secret-tool', ['clear', 'service', KEYCHAIN_SERVICE, 'account', account], {
    encoding: 'utf8',
    timeout: 30000,
  });
}

/* ---------------------------------------------------------------- AES-GCM */

async function loadAesKey() {
  const passphrase = process.env.MOODLE_VAULT_KEY;
  if (passphrase) {
    const salt = randomBytes(16);
    const key = scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return { key, kdf: { name: 'scrypt', salt: salt.toString('base64'), N: 16384, r: 8, p: 1 } };
  }
  let raw;
  try {
    raw = Buffer.from((await fs.readFile(KEY_FILE, 'utf8')).trim(), 'base64');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    raw = randomBytes(32);
    await fs.mkdir(SECRETS_DIR, { recursive: true });
    await fs.writeFile(KEY_FILE, raw.toString('base64') + '\n', 'utf8');
    await harden(KEY_FILE, false);
  }
  if (raw.length !== 32) throw new VaultError(KEY_FILE + ' does not hold a 32-byte key');
  return { key: raw, kdf: { name: 'none', keyFile: path.basename(KEY_FILE) } };
}

async function deriveAesKey(kdf) {
  if (kdf && kdf.name === 'scrypt') {
    const passphrase = process.env.MOODLE_VAULT_KEY;
    if (!passphrase) {
      throw new VaultError('This vault needs MOODLE_VAULT_KEY (the passphrase it was created with)');
    }
    const salt = Buffer.from(kdf.salt, 'base64');
    return scryptSync(passphrase, salt, 32, {
      N: kdf.N || 16384,
      r: kdf.r || 8,
      p: kdf.p || 1,
      maxmem: 64 * 1024 * 1024,
    });
  }
  const rawKey = Buffer.from((await fs.readFile(KEY_FILE, 'utf8')).trim(), 'base64');
  if (rawKey.length !== 32) throw new VaultError(KEY_FILE + ' does not hold a 32-byte key');
  return rawKey;
}

async function aesSeal(plain) {
  const { key, kdf } = await loadAesKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return {
    kdf,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
}

async function aesOpen(record) {
  const key = await deriveAesKey(record.kdf);
  const iv = Buffer.from(record.iv, 'base64');
  const tag = Buffer.from(record.tag, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(Buffer.from(record.ct, 'base64')), decipher.final()]);
  } catch {
    throw new VaultError('Cannot decrypt the vault: wrong key or the file was modified');
  }
}

/* --------------------------------------------------------------- sealing */

/** Seal an object into a vault record. */
export async function sealJson(obj, { backend, account = KEYCHAIN_ACCOUNT } = {}) {
  const name = resolveBackend(backend);
  const plain = Buffer.from(JSON.stringify(obj), 'utf8');
  const stamp = new Date().toISOString();

  if (name === 'dpapi') {
    return {
      v: 1,
      backend: 'dpapi',
      scope: 'current-user',
      account,
      sealedAt: stamp,
      blob: dpapiProtect(plain).toString('base64'),
    };
  }
  if (name === 'keychain') {
    keychainStore(account, plain.toString('base64'));
    return { v: 1, backend: 'keychain', service: KEYCHAIN_SERVICE, account, sealedAt: stamp };
  }
  if (name === 'secret-service') {
    secretToolStore(account, plain.toString('base64'));
    return { v: 1, backend: 'secret-service', service: KEYCHAIN_SERVICE, account, sealedAt: stamp };
  }
  const sealed = await aesSeal(plain);
  return { v: 1, backend: 'aes-gcm', account, sealedAt: stamp, ...sealed };
}

/** Open a vault record produced by sealJson(). */
export async function openJson(record) {
  if (!record || typeof record !== 'object') throw new VaultError('Not a vault record');
  if (record.v !== 1) throw new VaultError('Unsupported vault version: ' + record.v);
  let plain;
  switch (record.backend) {
    case 'dpapi':
      plain = dpapiUnprotect(Buffer.from(record.blob, 'base64'));
      break;
    case 'keychain':
      plain = Buffer.from(keychainLoad(record.account || KEYCHAIN_ACCOUNT), 'base64');
      break;
    case 'secret-service':
      plain = Buffer.from(secretToolLoad(record.account || KEYCHAIN_ACCOUNT), 'base64');
      break;
    case 'aes-gcm':
      plain = await aesOpen(record);
      break;
    default:
      throw new VaultError('Unknown vault backend in the record: ' + record.backend);
  }
  try {
    return JSON.parse(plain.toString('utf8'));
  } catch {
    throw new VaultError('The vault payload is not valid JSON');
  }
}

/* -------------------------------------------------------------- file ops */

/** Restrict a file/directory to the current user (chmod on POSIX, ACL on Windows). */
export async function harden(target, isDir = false) {
  if (process.platform === 'win32') {
    const user = process.env.USERNAME;
    if (!user) return;
    const grant = isDir ? user + ':(OI)(CI)F' : user + ':F';
    spawnSync('icacls', [target, '/inheritance:r', '/grant:r', grant], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 30000,
    });
    return;
  }
  try {
    await fs.chmod(target, isDir ? 0o700 : 0o600);
  } catch {
    /* exotic filesystem - the OS keyring still protects the payload */
  }
}

const cache = new Map();

/** Read and decrypt a vault file. Returns null when the file does not exist. */
export async function readVault(file) {
  let raw;
  let st;
  try {
    st = await fs.stat(file);
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.obj;

  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    throw new VaultError(path.basename(file) + ' is not a valid vault record');
  }
  const obj = await openJson(record);
  cache.set(file, { mtimeMs: st.mtimeMs, obj });
  return obj;
}

/** Encrypt an object and write it to a vault file atomically. */
export async function writeVault(file, obj, options = {}) {
  const record = await sealJson(obj, options);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await harden(path.dirname(file), true);
  const tmp = file + '.' + process.pid + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(record, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  await harden(tmp, false);
  await fs.rename(tmp, file);
  await harden(file, false);
  cache.delete(file);
  return record;
}

/** Remove a vault file and, for keyring backends, the keyring item behind it. */
export async function destroyVault(file) {
  let record = null;
  try {
    record = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    /* missing or unreadable: nothing to unseal */
  }
  if (record && record.backend === 'keychain') keychainDelete(record.account || KEYCHAIN_ACCOUNT);
  if (record && record.backend === 'secret-service') secretToolDelete(record.account || KEYCHAIN_ACCOUNT);
  await fs.rm(file, { force: true });
  cache.delete(file);
}

/** Overwrite a file with random bytes, flush it and unlink it. */
export async function shredFile(file) {
  let st;
  try {
    st = await fs.stat(file);
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  const fh = await fs.open(file, 'r+');
  try {
    const filler = randomBytes(Math.max(1, Math.min(st.size, 1024 * 1024)));
    let written = 0;
    while (written < st.size) {
      const slice = filler.subarray(0, Math.min(filler.length, st.size - written));
      await fh.write(slice, 0, slice.length, written);
      written += slice.length;
    }
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rm(file, { force: true });
  return true;
}

/** Metadata for the status command: never returns the payload. */
export async function describeVault(file) {
  try {
    const st = await fs.stat(file);
    let record = null;
    try {
      record = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      /* a corrupt record is reported as backend: null */
    }
    return {
      exists: true,
      path: file,
      bytes: st.size,
      modified: st.mtime,
      backend: record && record.backend,
      account: record && record.account,
      sealedAt: record && record.sealedAt,
    };
  } catch (err) {
    if (err.code === 'ENOENT') return { exists: false, path: file };
    throw err;
  }
}
