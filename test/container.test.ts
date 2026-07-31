import { webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  CONTAINER_VERSION,
  HEADER_LENGTH,
  KEYCHECK_PLAINTEXT,
  MAGIC,
  NONCE_LENGTH,
  TAG_LENGTH,
  createKeycheck,
  decodeContainer,
  decrypt,
  encodeContainer,
  encrypt,
  encryptWithNonce,
  isContainer,
  verifyKeycheck,
} from '../src/core/container';
import { deriveKey, generateSalt } from '../src/core/kdf';
import { utf8Decode, utf8Encode } from '../src/core/bytes';
import type { Bytes, CryptoProvider } from '../src/types';

// Node's webcrypto and the DOM's Crypto are structurally the same object with
// separately-declared types. One cast here beats one at every call site.
const crypto = webcrypto as unknown as CryptoProvider;

const PASSPHRASE = 'a passphrase for the tests';
const SLOW = 30_000;

let salt: Bytes;
let key: CryptoKey;
let otherKey: CryptoKey;

beforeAll(async () => {
  salt = generateSalt(crypto);
  const derived = await deriveKey(crypto, PASSPHRASE, salt);
  const otherDerived = await deriveKey(crypto, 'a different passphrase', salt);
  if (!derived.ok || !otherDerived.ok) throw new Error('key derivation failed in setup');
  key = derived.value;
  otherKey = otherDerived.value;
}, SLOW);

describe('encodeContainer / decodeContainer', () => {
  const nonce = new Uint8Array(NONCE_LENGTH).fill(7);
  const body = utf8Encode('ciphertext-stand-in-plus-tag-padding-to-length');

  it('lays the header out in the documented order', () => {
    const encoded = encodeContainer(new Uint8Array(16).fill(3), nonce, body);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;

    expect(encoded.value.slice(0, 4)).toEqual(MAGIC);
    expect(encoded.value[4]).toBe(CONTAINER_VERSION);
    expect(encoded.value.slice(5, 21)).toEqual(new Uint8Array(16).fill(3));
    expect(encoded.value.slice(21, 33)).toEqual(nonce);
    expect(encoded.value.slice(HEADER_LENGTH)).toEqual(body);
  });

  it('round-trips the three fields', () => {
    const encoded = encodeContainer(new Uint8Array(16).fill(9), nonce, body);
    if (!encoded.ok) throw new Error('encode failed');

    const parts = decodeContainer(encoded.value);
    expect(parts.ok).toBe(true);
    if (!parts.ok) return;

    expect(parts.value.salt).toEqual(new Uint8Array(16).fill(9));
    expect(parts.value.nonce).toEqual(nonce);
    expect(parts.value.ciphertext).toEqual(body);
  });

  it('rejects a wrong-sized salt or nonce', () => {
    expect(encodeContainer(new Uint8Array(15), nonce, body).ok).toBe(false);
    expect(encodeContainer(new Uint8Array(16), new Uint8Array(11), body).ok).toBe(false);
  });

  it('rejects bytes without the magic number', () => {
    const notOurs = utf8Encode('PK this is a zip file, not a container');
    expect(isContainer(notOurs)).toBe(false);
    expect(decodeContainer(notOurs).ok).toBe(false);
  });

  it('rejects an unknown container version', () => {
    const encoded = encodeContainer(new Uint8Array(16), nonce, body);
    if (!encoded.ok) throw new Error('encode failed');
    encoded.value[4] = 0x02;

    const parts = decodeContainer(encoded.value);
    expect(parts.ok).toBe(false);
    if (parts.ok) return;
    expect(parts.error.kind).toBe('crypto');
    expect(parts.error.message).toContain('not supported');
  });

  it('rejects a container too short to hold a tag', () => {
    const truncated = encodeContainer(new Uint8Array(16), nonce, new Uint8Array(TAG_LENGTH - 1));
    if (!truncated.ok) throw new Error('encode failed');
    expect(decodeContainer(truncated.value).ok).toBe(false);
  });
});

describe('encrypt / decrypt', () => {
  it('round-trips an empty file', { timeout: SLOW }, async () => {
    const sealed = await encrypt(crypto, key, salt, new Uint8Array(0));
    if (!sealed.ok) throw new Error(sealed.error.message);

    // Nothing but header and tag.
    expect(sealed.value.length).toBe(HEADER_LENGTH + TAG_LENGTH);

    const opened = await decrypt(crypto, key, sealed.value);
    if (!opened.ok) throw new Error(opened.error.message);
    expect(opened.value.length).toBe(0);
  });

  it('round-trips utf-8 with cyrillic and emoji', { timeout: SLOW }, async () => {
    const text = 'Привет 🌍 — заметка\nwith a tab\tand a NUL-free body\n';
    const sealed = await encrypt(crypto, key, salt, utf8Encode(text));
    if (!sealed.ok) throw new Error(sealed.error.message);

    const opened = await decrypt(crypto, key, sealed.value);
    if (!opened.ok) throw new Error(opened.error.message);
    expect(utf8Decode(opened.value)).toBe(text);
  });

  it('round-trips 1 MiB of binary', { timeout: SLOW }, async () => {
    // Filled in 64 KiB chunks: getRandomValues rejects anything larger.
    const plaintext = new Uint8Array(1024 * 1024);
    for (let offset = 0; offset < plaintext.length; offset += 65_536) {
      crypto.getRandomValues(plaintext.subarray(offset, offset + 65_536));
    }

    const sealed = await encrypt(crypto, key, salt, plaintext);
    if (!sealed.ok) throw new Error(sealed.error.message);

    const opened = await decrypt(crypto, key, sealed.value);
    if (!opened.ok) throw new Error(opened.error.message);
    expect(opened.value).toEqual(plaintext);
  });

  it('produces a different container every time for the same input', { timeout: SLOW }, async () => {
    const plaintext = utf8Encode('unchanged content');
    const first = await encrypt(crypto, key, salt, plaintext);
    const second = await encrypt(crypto, key, salt, plaintext);
    if (!first.ok || !second.ok) throw new Error('encryption failed');

    // The nonce is fresh each time. This is exactly why staleness is decided by
    // the plaintext hash and never by comparing ciphertext or remote md5.
    expect(first.value).not.toEqual(second.value);
    expect(first.value.slice(21, 33)).not.toEqual(second.value.slice(21, 33));
  });

  it('embeds the salt it was given', { timeout: SLOW }, async () => {
    const sealed = await encrypt(crypto, key, salt, utf8Encode('x'));
    if (!sealed.ok) throw new Error(sealed.error.message);

    const parts = decodeContainer(sealed.value);
    if (!parts.ok) throw new Error(parts.error.message);
    expect(parts.value.salt).toEqual(salt);
  });

  it('fails with the wrong key', { timeout: SLOW }, async () => {
    const sealed = await encrypt(crypto, key, salt, utf8Encode('secret'));
    if (!sealed.ok) throw new Error(sealed.error.message);

    const opened = await decrypt(crypto, otherKey, sealed.value);
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.error.kind).toBe('crypto');
  });

  it('fails when a single ciphertext byte is flipped', { timeout: SLOW }, async () => {
    const sealed = await encrypt(crypto, key, salt, utf8Encode('tamper target'));
    if (!sealed.ok) throw new Error(sealed.error.message);

    const damaged = sealed.value.slice();
    const target = damaged[HEADER_LENGTH] ?? 0;
    damaged[HEADER_LENGTH] = target ^ 0x01;

    expect((await decrypt(crypto, key, damaged)).ok).toBe(false);
  });

  it('fails when the nonce in the header is edited', { timeout: SLOW }, async () => {
    const sealed = await encrypt(crypto, key, salt, utf8Encode('tamper target'));
    if (!sealed.ok) throw new Error(sealed.error.message);

    const damaged = sealed.value.slice();
    const target = damaged[21] ?? 0;
    damaged[21] = target ^ 0xff;

    expect((await decrypt(crypto, key, damaged)).ok).toBe(false);
  });

  it('rejects a nonce of the wrong length', { timeout: SLOW }, async () => {
    const bad = await encryptWithNonce(crypto, key, salt, new Uint8Array(8), utf8Encode('x'));
    expect(bad.ok).toBe(false);
  });
});

describe('keycheck', () => {
  it('accepts the key that created it', { timeout: SLOW }, async () => {
    const file = await createKeycheck(crypto, key, salt);
    if (!file.ok) throw new Error(file.error.message);

    expect(isContainer(file.value)).toBe(true);
    expect((await verifyKeycheck(crypto, key, file.value)).ok).toBe(true);
  });

  it('rejects any other key', { timeout: SLOW }, async () => {
    const file = await createKeycheck(crypto, key, salt);
    if (!file.ok) throw new Error(file.error.message);

    const result = await verifyKeycheck(crypto, otherKey, file.value);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('does not match this vault');
  });

  it('holds the documented marker text', { timeout: SLOW }, async () => {
    const file = await createKeycheck(crypto, key, salt);
    if (!file.ok) throw new Error(file.error.message);

    const opened = await decrypt(crypto, key, file.value);
    if (!opened.ok) throw new Error(opened.error.message);
    expect(utf8Decode(opened.value)).toBe(KEYCHECK_PLAINTEXT);
  });
});
