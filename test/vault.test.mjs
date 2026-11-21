import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// The vault paths are read at import time, so the temporary directory has to be in place
// before the modules are loaded. The portable backend keeps the test offline and
// deterministic on every OS.
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moodle-vault-test-'));
process.env.MOODLE_SECRETS_DIR = dir;
process.env.MOODLE_VAULT_BACKEND = 'aes-gcm';
delete process.env.MOODLE_VAULT_KEY;

const vault = await import('../lib/vault.mjs');
const auth = await import('../lib/auth.mjs');

const SECRET = { username: 'student-1', password: 'p@ssw0rd-!', baseUrl: 'https://moodle.example.edu' };

after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

test('AEAD vault round-trips and keeps the values off disk', async () => {
  await vault.writeVault(vault.VAULT_FILE, SECRET, { backend: 'aes-gcm' });
  assert.deepEqual(await vault.readVault(vault.VAULT_FILE), SECRET);
  const raw = await fs.readFile(vault.VAULT_FILE, 'utf8');
  for (const value of ['student-1', 'p@ssw0rd-!', 'moodle.example.edu']) {
    assert.ok(!raw.includes(value), 'plaintext ' + value + ' must not appear in the vault file');
  }
  const record = JSON.parse(raw);
  assert.equal(record.backend, 'aes-gcm');
  assert.equal(record.v, 1);
});

test('the token cache never keeps the login', async () => {
  await vault.writeVault(
    vault.TOKEN_VAULT_FILE,
    { token: 'tok-123', baseUrl: SECRET.baseUrl, savedAt: 'now' },
    { backend: 'aes-gcm', account: 'token' },
  );
  const back = await vault.readVault(vault.TOKEN_VAULT_FILE);
  assert.equal(back.token, 'tok-123');
  assert.ok(!('username' in back));
});

test('a modified ciphertext is rejected', async () => {
  const record = await vault.sealJson(SECRET, { backend: 'aes-gcm' });
  const tampered = Buffer.from(record.ct, 'base64');
  tampered[0] ^= 0xff;
  record.ct = tampered.toString('base64');
  await assert.rejects(() => vault.openJson(record), /Cannot decrypt/);
});

test('describeVault reports metadata without the payload', async () => {
  await vault.writeVault(vault.VAULT_FILE, SECRET, { backend: 'aes-gcm' });
  const info = await vault.describeVault(vault.VAULT_FILE);
  assert.equal(info.exists, true);
  assert.equal(info.backend, 'aes-gcm');
  assert.equal(JSON.stringify(info).includes('p@ssw0rd-!'), false);
});

test('shredFile overwrites and removes the file', async () => {
  const target = path.join(dir, 'shred-me.txt');
  await fs.writeFile(target, 'plaintext credential', 'utf8');
  assert.equal(await vault.shredFile(target), true);
  await assert.rejects(() => fs.stat(target));
  assert.equal(await vault.shredFile(target), false);
});

test('a legacy plaintext file is encrypted, verified and shredded', async () => {
  await fs.writeFile(
    vault.LEGACY_CREDS,
    JSON.stringify({ username: 'legacy-user', password: 'legacy-pass', baseUrl: 'https://legacy.example.edu' }),
    'utf8',
  );
  await fs.writeFile(
    vault.LEGACY_TOKEN,
    JSON.stringify({ token: 'legacy-token', baseUrl: 'https://legacy.example.edu' }),
    'utf8',
  );

  const summary = await auth.migrateLegacySecrets({ backend: 'aes-gcm' });
  assert.equal(summary.credentials, true);
  assert.equal(summary.token, true);
  await assert.rejects(() => fs.stat(vault.LEGACY_CREDS));
  await assert.rejects(() => fs.stat(vault.LEGACY_TOKEN));

  const creds = await auth.loadCredentials();
  assert.equal(creds.username, 'legacy-user');
  assert.equal(creds.password, 'legacy-pass');
  assert.equal(creds.baseUrl, 'https://legacy.example.edu');
});

test('a non-https site is refused', async () => {
  await assert.rejects(
    () => auth.saveCredentials({ username: 'a', password: 'b', baseUrl: 'http://moodle.example.edu' }),
    /Refusing a plain http/,
  );
});
