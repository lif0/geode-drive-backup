/**
 * Regenerates test/vectors.json.
 *
 * Run this ONLY when adding a new container version. Existing cases are frozen:
 * a vault encrypted by an older build must keep decrypting forever, and the
 * vectors are the proof. Changing a recorded case silently breaks that promise.
 *
 *   node tools/make-vectors.mjs
 *
 * The implementation here is deliberately independent of src/core/container.ts.
 * If the two ever disagree, test/vectors.test.ts fails and one of them is wrong.
 */
import { webcrypto } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import process from 'node:process';

/** @typedef {import('node:crypto').webcrypto.CryptoKey} CryptoKey */
/**
 * @typedef {{ name: string, passphrase: string, saltHex: string, nonceHex: string,
 *             plaintextBase64: string, containerBase64: string }} VectorCase
 */

const MAGIC = Uint8Array.from([0x4f, 0x42, 0x45, 0x56]);
const VERSION = 1;
const ITERATIONS = 600_000;

/**
 * Deterministic byte source (xorshift32), so the 1 MB case is reproducible
 * without committing a binary fixture.
 * @param {number} seed
 * @param {number} length
 */
function pseudoRandomBytes(seed, length) {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i += 1) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out[i] = state & 0xff;
  }
  return out;
}

/** @param {string} hex */
function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * @param {string} passphrase
 * @param {Uint8Array} salt
 */
async function deriveKey(passphrase, salt) {
  const material = await webcrypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return webcrypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * @param {CryptoKey} key
 * @param {Uint8Array} salt
 * @param {Uint8Array} nonce
 * @param {Uint8Array} plaintext
 */
async function seal(key, salt, nonce, plaintext) {
  const sealed = new Uint8Array(
    await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, key, plaintext),
  );
  const out = new Uint8Array(MAGIC.length + 1 + salt.length + nonce.length + sealed.length);
  out.set(MAGIC, 0);
  out[MAGIC.length] = VERSION;
  out.set(salt, MAGIC.length + 1);
  out.set(nonce, MAGIC.length + 1 + salt.length);
  out.set(sealed, MAGIC.length + 1 + salt.length + nonce.length);
  return out;
}

const cases = [
  {
    name: 'empty file',
    passphrase: 'correct horse battery staple',
    saltHex: '000102030405060708090a0b0c0d0e0f',
    nonceHex: 'a0a1a2a3a4a5a6a7a8a9aaab',
    plaintext: new Uint8Array(0),
  },
  {
    name: 'short ascii',
    passphrase: 'correct horse battery staple',
    saltHex: '0f0e0d0c0b0a09080706050403020100',
    nonceHex: 'b0b1b2b3b4b5b6b7b8b9babb',
    plaintext: new TextEncoder().encode('# Hello\n\nThe quick brown fox jumps over the lazy dog.\n'),
  },
  {
    name: 'utf-8 with cyrillic and emoji',
    // A non-ASCII passphrase too: the KDF hashes utf-8 bytes, not code units.
    passphrase: 'пароль-🔐-passphrase',
    saltHex: 'deadbeefdeadbeefdeadbeefdeadbeef',
    nonceHex: 'c0c1c2c3c4c5c6c7c8c9cacb',
    plaintext: new TextEncoder().encode(
      'Привет, мир! 🌍\nЗаметка про шифрование 🔒\nGrüße, ünïcode — “quotes” … ✅\n',
    ),
  },
  {
    name: '1 MiB binary',
    passphrase: 'correct horse battery staple',
    saltHex: '112233445566778899aabbccddeeff00',
    nonceHex: 'd0d1d2d3d4d5d6d7d8d9dadb',
    plaintext: pseudoRandomBytes(0x9e3779b9, 1024 * 1024),
  },
];

const out = {
  $comment:
    'Golden vectors for the OBEV container. Frozen: add cases for a new VERSION, never edit an existing one. Regenerate with `node tools/make-vectors.mjs`.',
  format: 'OBEV',
  version: VERSION,
  kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, keyLengthBits: 256 },
  cipher: 'AES-256-GCM',
  nonceLength: 12,
  saltLength: 16,
  /** @type {VectorCase[]} */
  cases: [],
};

for (const testCase of cases) {
  const salt = fromHex(testCase.saltHex);
  const nonce = fromHex(testCase.nonceHex);
  const key = await deriveKey(testCase.passphrase, salt);
  const container = await seal(key, salt, nonce, testCase.plaintext);

  out.cases.push({
    name: testCase.name,
    passphrase: testCase.passphrase,
    saltHex: testCase.saltHex,
    nonceHex: testCase.nonceHex,
    plaintextBase64: Buffer.from(testCase.plaintext).toString('base64'),
    containerBase64: Buffer.from(container).toString('base64'),
  });

  console.log(`${testCase.name}: ${String(testCase.plaintext.length)} bytes plaintext`);
}

writeFileSync('test/vectors.json', `${JSON.stringify(out, null, 2)}\n`, 'utf8');
console.log(`Wrote test/vectors.json (${String(out.cases.length)} cases)`);
process.exitCode = 0;
