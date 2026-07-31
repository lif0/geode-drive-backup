/**
 * Uint8Array helpers.
 *
 * Base64 is implemented here rather than via `btoa`/`atob` because those take a
 * binary string, and `String.fromCharCode(...bytes)` blows the call stack on the
 * 1 MB attachments this plugin is expected to handle.
 */

import type { Bytes, CryptoProvider, Sha256Hex } from '../types';
import { sha256Hex } from '../types';

const BASE64_STANDARD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const HEX_DIGITS = '0123456789abcdef';
const INVALID = 255;

// Stateless and immutable, so a module-level instance is not shared state.
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: false });

function buildDecodeTable(alphabet: string): Bytes {
  const table = new Uint8Array(256).fill(INVALID);
  for (let i = 0; i < alphabet.length; i += 1) {
    table[alphabet.charCodeAt(i)] = i;
  }
  return table;
}

const BASE64_STANDARD_DECODE = buildDecodeTable(BASE64_STANDARD);
const BASE64_URL_DECODE = buildDecodeTable(BASE64_URL);

/** Joins byte arrays into one new array. */
export function concatBytes(...parts: readonly Bytes[]): Bytes {
  let total = 0;
  for (const part of parts) total += part.length;

  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * True if both arrays hold the same bytes.
 *
 * Does NOT run in constant time. Never use it to compare an authentication tag
 * or anything else an attacker can supply repeatedly; AES-GCM verifies its own
 * tag inside WebCrypto, which is where that comparison belongs.
 */
export function bytesEqual(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** True if `bytes` starts with `prefix`. */
export function startsWithBytes(bytes: Bytes, prefix: Bytes): boolean {
  if (bytes.length < prefix.length) return false;
  return bytesEqual(bytes.subarray(0, prefix.length), prefix);
}

/** Lowercase hex, two characters per byte. */
export function toHex(bytes: Bytes): string {
  let out = '';
  for (const byte of bytes) {
    out += HEX_DIGITS[byte >>> 4] ?? '0';
    out += HEX_DIGITS[byte & 0x0f] ?? '0';
  }
  return out;
}

/** Parses lowercase or uppercase hex. Returns null on odd length or a bad digit. */
export function fromHex(hex: string): Bytes | null {
  if (hex.length % 2 !== 0) return null;

  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) return null;
    out[i] = byte;
  }
  return out;
}

function encodeBase64(bytes: Bytes, alphabet: string, padded: boolean): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];

    out += alphabet[b0 >>> 2] ?? '';
    out += alphabet[((b0 & 0x03) << 4) | ((b1 ?? 0) >>> 4)] ?? '';

    if (b1 === undefined) {
      if (padded) out += '==';
      break;
    }
    out += alphabet[((b1 & 0x0f) << 2) | ((b2 ?? 0) >>> 6)] ?? '';

    if (b2 === undefined) {
      if (padded) out += '=';
      break;
    }
    out += alphabet[b2 & 0x3f] ?? '';
  }
  return out;
}

function decodeBase64(text: string, table: Bytes): Bytes | null {
  let end = text.length;
  while (end > 0 && text[end - 1] === '=') end -= 1;

  const symbols = new Uint8Array(end);
  for (let i = 0; i < end; i += 1) {
    const symbol = table[text.charCodeAt(i)] ?? INVALID;
    if (symbol === INVALID) return null;
    symbols[i] = symbol;
  }

  // Every 4 symbols carry 3 bytes; a lone trailing symbol is not a valid group.
  const remainder = symbols.length % 4;
  if (remainder === 1) return null;

  const outLength = Math.floor((symbols.length * 6) / 8);
  const out = new Uint8Array(outLength);
  let bitBuffer = 0;
  let bitCount = 0;
  let written = 0;

  for (const symbol of symbols) {
    bitBuffer = (bitBuffer << 6) | symbol;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      out[written] = (bitBuffer >>> bitCount) & 0xff;
      written += 1;
    }
  }
  return out;
}

/** Standard base64 with padding. */
export function toBase64(bytes: Bytes): string {
  return encodeBase64(bytes, BASE64_STANDARD, true);
}

/** Parses standard base64. Returns null if a character is outside the alphabet. */
export function fromBase64(text: string): Bytes | null {
  return decodeBase64(text, BASE64_STANDARD_DECODE);
}

/** base64url without padding, the form Drive file names use. */
export function toBase64Url(bytes: Bytes): string {
  return encodeBase64(bytes, BASE64_URL, false);
}

/** Parses unpadded base64url. Returns null on any character outside the alphabet. */
export function fromBase64Url(text: string): Bytes | null {
  return decodeBase64(text, BASE64_URL_DECODE);
}

/** Encodes text as utf-8. */
export function utf8Encode(text: string): Bytes {
  return utf8Encoder.encode(text);
}

/**
 * Decodes utf-8. Invalid sequences become U+FFFD rather than throwing, so a
 * corrupt download degrades to visible damage instead of an unhandled error.
 */
export function utf8Decode(bytes: Bytes): string {
  return utf8Decoder.decode(bytes);
}

/**
 * SHA-256 of `bytes`, as lowercase hex.
 *
 * Always fed the PLAINTEXT. The digest is the only signal Geode uses to decide a
 * file changed, and for encrypted files it must never leave this device — it
 * would let anyone confirm a guess at the contents.
 */
export async function hashBytes(crypto: CryptoProvider, bytes: Bytes): Promise<Sha256Hex> {
  const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(bytes));
  return sha256Hex(toHex(new Uint8Array(digest)));
}

/**
 * Copies `bytes` into a standalone ArrayBuffer.
 *
 * `requestUrl` and `writeBinary` take an ArrayBuffer. Passing `.buffer` directly
 * would send the whole backing store when the array is a subarray view.
 */
export function toArrayBuffer(bytes: Bytes): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}
