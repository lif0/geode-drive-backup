import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { decrypt, encryptWithNonce } from '../src/core/container';
import { deriveKey } from '../src/core/kdf';
import { fromBase64, fromHex, toBase64 } from '../src/core/bytes';
import type { CryptoProvider } from '../src/types';

/**
 * The golden vectors are the contract between src/core/container.ts and
 * tools/decrypt.mjs. Both must decode every case to the same plaintext, and both
 * must reproduce the recorded container byte for byte from the recorded salt and
 * nonce. tools/decrypt.mjs checks itself with `npm run verify:vectors`.
 */

const crypto = webcrypto as unknown as CryptoProvider;
const SLOW = 60_000;

interface VectorCase {
  readonly name: string;
  readonly passphrase: string;
  readonly saltHex: string;
  readonly nonceHex: string;
  readonly plaintextBase64: string;
  readonly containerBase64: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asVectorCase(value: unknown): VectorCase {
  if (!isRecord(value)) throw new Error('vector case is not an object');
  const { name, passphrase, saltHex, nonceHex, plaintextBase64, containerBase64 } = value;
  if (
    typeof name !== 'string' ||
    typeof passphrase !== 'string' ||
    typeof saltHex !== 'string' ||
    typeof nonceHex !== 'string' ||
    typeof plaintextBase64 !== 'string' ||
    typeof containerBase64 !== 'string'
  ) {
    throw new Error('vector case is missing a field');
  }
  return { name, passphrase, saltHex, nonceHex, plaintextBase64, containerBase64 };
}

function loadVectors(): { version: number; cases: VectorCase[] } {
  const path = fileURLToPath(new URL('./vectors.json', import.meta.url));
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(parsed)) throw new Error('vectors.json is not an object');

  const { version, cases } = parsed;
  if (typeof version !== 'number') throw new Error('vectors.json has no version');
  if (!Array.isArray(cases)) throw new Error('vectors.json has no cases');

  return { version, cases: cases.map(asVectorCase) };
}

const vectors = loadVectors();

describe('golden vectors', () => {
  it('cover the four required shapes', () => {
    expect(vectors.version).toBe(1);
    expect(vectors.cases.length).toBeGreaterThanOrEqual(4);

    const sizes = vectors.cases.map(
      (testCase) => fromBase64(testCase.plaintextBase64)?.length ?? -1,
    );
    expect(sizes).toContain(0);
    expect(Math.max(...sizes)).toBeGreaterThanOrEqual(1024 * 1024);
  });

  for (const testCase of vectors.cases) {
    describe(testCase.name, () => {
      it('decrypts to the recorded plaintext', { timeout: SLOW }, async () => {
        const salt = fromHex(testCase.saltHex);
        const container = fromBase64(testCase.containerBase64);
        const expected = fromBase64(testCase.plaintextBase64);
        if (salt === null || container === null || expected === null) {
          throw new Error('vector is not decodable');
        }

        const key = await deriveKey(crypto, testCase.passphrase, salt);
        if (!key.ok) throw new Error(key.error.message);

        const opened = await decrypt(crypto, key.value, container);
        if (!opened.ok) throw new Error(opened.error.message);
        expect(opened.value).toEqual(expected);
      });

      it('reproduces the recorded container exactly', { timeout: SLOW }, async () => {
        const salt = fromHex(testCase.saltHex);
        const nonce = fromHex(testCase.nonceHex);
        const plaintext = fromBase64(testCase.plaintextBase64);
        if (salt === null || nonce === null || plaintext === null) {
          throw new Error('vector is not decodable');
        }

        const key = await deriveKey(crypto, testCase.passphrase, salt);
        if (!key.ok) throw new Error(key.error.message);

        const sealed = await encryptWithNonce(crypto, key.value, salt, nonce, plaintext);
        if (!sealed.ok) throw new Error(sealed.error.message);
        expect(toBase64(sealed.value)).toBe(testCase.containerBase64);
      });

      it('does not decrypt under a different passphrase', { timeout: SLOW }, async () => {
        const salt = fromHex(testCase.saltHex);
        const container = fromBase64(testCase.containerBase64);
        if (salt === null || container === null) throw new Error('vector is not decodable');

        const key = await deriveKey(crypto, `${testCase.passphrase} `, salt);
        if (!key.ok) throw new Error(key.error.message);

        expect((await decrypt(crypto, key.value, container)).ok).toBe(false);
      });
    });
  }
});
