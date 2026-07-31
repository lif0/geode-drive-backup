#!/usr/bin/env node
/**
 * Geode disaster-recovery decryptor.
 *
 * Standalone by design. It imports nothing from src/, needs no npm install and
 * no build step — copy this one file next to your downloaded Drive folder and it
 * will get your notes back with only Node and your passphrase. If it ever needs
 * the plugin to work, it has failed at its job.
 *
 *   node decrypt.mjs <file>                  decrypt one container to stdout
 *   node decrypt.mjs <file> -o <out>         decrypt one container to a file
 *   node decrypt.mjs --dir <in> --out <out>  rebuild a whole vault from a folder
 *   node decrypt.mjs --verify-vectors [path] check this file against the vectors
 *
 * The passphrase comes from --passphrase, else GEODE_PASSPHRASE, else a prompt.
 *
 * Container layout, repeated here so this file stands alone:
 *   MAGIC "OBEV" (4) | VERSION 0x01 (1) | SALT (16) | NONCE (12) | AES-256-GCM ciphertext+tag
 * Key: PBKDF2-SHA256, 600000 iterations, 32-byte key, salt taken from the header.
 */
import { webcrypto } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';

/** @typedef {import('node:crypto').webcrypto.CryptoKey} CryptoKey */

const MAGIC = Uint8Array.from([0x4f, 0x42, 0x45, 0x56]);
const VERSION = 1;
const ITERATIONS = 600_000;
const SALT_LENGTH = 16;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER_LENGTH = MAGIC.length + 1 + SALT_LENGTH + NONCE_LENGTH;
const KEYCHECK_NAME = '__keycheck';

/* ------------------------------- format ---------------------------------- */

/** @param {Uint8Array} bytes */
function isContainer(bytes) {
  if (bytes.length < MAGIC.length) return false;
  return MAGIC.every((byte, i) => bytes[i] === byte);
}

/**
 * Splits a container into its header fields.
 * @param {Uint8Array} bytes
 */
function parseContainer(bytes) {
  if (!isContainer(bytes)) throw new Error('Not a Geode container (bad magic number).');
  if (bytes.length < HEADER_LENGTH + TAG_LENGTH) throw new Error('Container is truncated.');

  const version = bytes[MAGIC.length];
  if (version !== VERSION) {
    throw new Error(`Container version ${version} is not supported by this tool.`);
  }

  const saltStart = MAGIC.length + 1;
  const nonceStart = saltStart + SALT_LENGTH;
  const bodyStart = nonceStart + NONCE_LENGTH;

  return {
    salt: bytes.slice(saltStart, nonceStart),
    nonce: bytes.slice(nonceStart, bodyStart),
    ciphertext: bytes.slice(bodyStart),
  };
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
  const out = new Uint8Array(HEADER_LENGTH + sealed.length);
  out.set(MAGIC, 0);
  out[MAGIC.length] = VERSION;
  out.set(salt, MAGIC.length + 1);
  out.set(nonce, MAGIC.length + 1 + SALT_LENGTH);
  out.set(sealed, HEADER_LENGTH);
  return out;
}

/**
 * Decrypts a container with `passphrase`, deriving the key from the embedded salt.
 * @param {Uint8Array} container
 * @param {string} passphrase
 */
async function openContainer(container, passphrase) {
  const { salt, nonce, ciphertext } = parseContainer(container);
  const key = await deriveKey(passphrase, salt);
  try {
    const opened = await webcrypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, tagLength: 128 },
      key,
      ciphertext,
    );
    return new Uint8Array(opened);
  } catch {
    throw new Error('Decryption failed: wrong passphrase, or the file is damaged.');
  }
}

/* ------------------------------ vault names ------------------------------- */

/**
 * Drive file names are base64url of the utf-8 vault path.
 * @param {string} name
 */
function decodeDriveName(name) {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return null;
  const text = Buffer.from(name, 'base64url').toString('utf8');
  if (text.length === 0 || text.includes('�') || text.includes('\0')) return null;
  if (text.startsWith('/') || text.includes('\\')) return null;
  if (text.split('/').some((part) => part === '' || part === '.' || part === '..')) return null;
  return text;
}

/* -------------------------------- input ---------------------------------- */

async function promptPassphrase() {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    // Node has no portable hidden prompt; the passphrase echoes. Prefer
    // GEODE_PASSPHRASE when someone might be reading over your shoulder.
    return await new Promise((res) => {
      rl.question('Passphrase: ', res);
    });
  } finally {
    rl.close();
  }
}

/** @param {Record<string, string | boolean>} flags */
async function resolvePassphrase(flags) {
  const fromFlag = flags['passphrase'];
  if (typeof fromFlag === 'string' && fromFlag.length > 0) return fromFlag;

  const fromEnv = process.env['GEODE_PASSPHRASE'];
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;

  return promptPassphrase();
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const flags = {};
  /** @type {string[]} */
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === '-o') {
      flags['out'] = argv[i + 1] ?? '';
      i += 1;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

/* ------------------------------- commands --------------------------------- */

/**
 * Checks this file's format code against the committed golden vectors.
 * @param {string | undefined} path
 */
async function verifyVectors(path) {
  const vectorPath = resolve(path ?? 'test/vectors.json');
  const parsed = JSON.parse(readFileSync(vectorPath, 'utf8'));

  if (parsed.version !== VERSION) {
    throw new Error(`vectors.json is version ${parsed.version}, this tool speaks ${VERSION}`);
  }

  let passed = 0;
  for (const testCase of parsed.cases) {
    const salt = Buffer.from(testCase.saltHex, 'hex');
    const nonce = Buffer.from(testCase.nonceHex, 'hex');
    const expectedPlain = Buffer.from(testCase.plaintextBase64, 'base64');
    const expectedContainer = Buffer.from(testCase.containerBase64, 'base64');

    const opened = Buffer.from(await openContainer(expectedContainer, testCase.passphrase));
    if (!opened.equals(expectedPlain)) {
      throw new Error(`${testCase.name}: decrypted bytes do not match the recorded plaintext`);
    }

    const key = await deriveKey(testCase.passphrase, salt);
    const rebuilt = Buffer.from(await seal(key, salt, nonce, expectedPlain));
    if (!rebuilt.equals(expectedContainer)) {
      throw new Error(`${testCase.name}: rebuilt container does not match the recorded bytes`);
    }

    console.log(`  ok  ${testCase.name} (${expectedPlain.length} bytes)`);
    passed += 1;
  }

  console.log(`\n${passed} vectors verified against tools/decrypt.mjs.`);
}

/**
 * @param {string} file
 * @param {Record<string, string | boolean>} flags
 */
async function decryptOne(file, flags) {
  const container = new Uint8Array(readFileSync(resolve(file)));
  if (!isContainer(container)) {
    throw new Error(`${file} is not encrypted — it has no OBEV header. Copy it as it is.`);
  }

  const plaintext = await openContainer(container, await resolvePassphrase(flags));
  const out = flags['out'];

  if (typeof out === 'string' && out.length > 0) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(resolve(out), plaintext);
    console.error(`Wrote ${out} (${plaintext.length} bytes)`);
  } else {
    process.stdout.write(plaintext);
  }
}

/**
 * Rebuilds a vault from a downloaded Drive folder: decodes each base64url name
 * back to its path, decrypts the encrypted ones and copies the rest through.
 * @param {string} inputDir
 * @param {string} outputDir
 * @param {Record<string, string | boolean>} flags
 */
async function decryptDirectory(inputDir, outputDir, flags) {
  const entries = readdirSync(resolve(inputDir)).filter((name) =>
    statSync(join(resolve(inputDir), name)).isFile(),
  );

  let passphrase = null;
  let restored = 0;
  let copied = 0;
  let skipped = 0;

  for (const name of entries) {
    if (name === KEYCHECK_NAME) continue;

    const path = decodeDriveName(name);
    if (path === null) {
      console.error(`skip  ${name} (name is not an encoded vault path)`);
      skipped += 1;
      continue;
    }

    const bytes = new Uint8Array(readFileSync(join(resolve(inputDir), name)));
    const target = join(resolve(outputDir), path);
    mkdirSync(dirname(target), { recursive: true });

    if (isContainer(bytes)) {
      passphrase ??= await resolvePassphrase(flags);
      writeFileSync(target, await openContainer(bytes, passphrase));
      console.error(`open  ${path}`);
      restored += 1;
    } else {
      writeFileSync(target, bytes);
      console.error(`copy  ${path}`);
      copied += 1;
    }
  }

  console.error(`\n${restored} decrypted, ${copied} copied, ${skipped} skipped.`);
}

const USAGE = `Geode disaster-recovery decryptor

  node decrypt.mjs <file> [-o <out>]
  node decrypt.mjs --dir <folder> --out <folder>
  node decrypt.mjs --verify-vectors [vectors.json]

  --passphrase <text>   otherwise GEODE_PASSPHRASE, otherwise you are prompted
`;

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));

  if (flags['help'] === true || flags['h'] === true) {
    console.log(USAGE);
    return;
  }

  if (flags['verify-vectors'] !== undefined) {
    const path = typeof flags['verify-vectors'] === 'string' ? flags['verify-vectors'] : undefined;
    await verifyVectors(path ?? positional[0]);
    return;
  }

  const dir = flags['dir'];
  if (typeof dir === 'string') {
    const out = flags['out'];
    if (typeof out !== 'string' || out.length === 0) {
      throw new Error('--dir needs --out <folder>');
    }
    await decryptDirectory(dir, out, flags);
    return;
  }

  const file = positional[0];
  if (file === undefined) {
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }

  await decryptOne(file, flags);
}

try {
  await main();
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
