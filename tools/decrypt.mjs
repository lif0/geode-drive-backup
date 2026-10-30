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
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
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
const DICTIONARY_NAME = '__geode_dictionary.json';
const DICTIONARY_BACKUP_NAME = '__geode_dictionary.previous.json';

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
 * Names carry base64url of a tokenized UTF-8 path. Keep this decoder aligned
 * with src/core/path-dictionary.ts; CLI integration tests exercise both.
 * @param {string} name
 * @param {Map<number, string>} dictionary
 */
function decodeDriveName(name, dictionary) {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`Unsupported path name: ${name}`);
  const encoded = name;
  const raw = Buffer.from(encoded, 'base64url');
  const text = raw.toString('utf8');
  if (
    raw.toString('base64url') !== encoded ||
    Buffer.from(text, 'utf8').toString('base64url') !== encoded
  ) {
    throw new Error('Invalid base64url or UTF-8 path name.');
  }
  let expanded = '';
  for (let offset = 0; offset < text.length;) {
    const char = text.charAt(offset);
    if (char !== '{' && char !== '}') {
      expanded += char;
      offset += 1;
    } else if (text.charAt(offset + 1) === char) {
      expanded += char;
      offset += 2;
    } else {
      const token = /^\{([1-9][0-9]*)\}/.exec(text.slice(offset));
      if (char !== '{' || token === null) throw new Error('Malformed dictionary token or brace.');
      const replacement = dictionary.get(Number(token[1]));
      if (replacement === undefined) throw new Error(`Unknown dictionary token ${token[0]}.`);
      expanded += replacement;
      offset += token[0].length;
    }
    if (expanded.length > 65536) throw new Error('Decoded path exceeds the safety limit.');
  }
  const path = expanded.normalize('NFC');
  if (
    path.length === 0 ||
    path.includes('\0') ||
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path) ||
    path.includes('\\') ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error('Unsafe decoded path.');
  }
  return path;
}

/** @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} folder */
function readDictionary(folder) {
  const file = join(folder, DICTIONARY_NAME);
  if (!existsSync(file))
    throw new Error(`Missing ${DICTIONARY_NAME}. Download it together with the backup.`);
  if (lstatSync(file).isSymbolicLink() || statSync(file).size > 8 * 1024 * 1024)
    throw new Error('Invalid dictionary file.');
  const bytes = readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('Dictionary is not valid UTF-8.');
  /** @type {unknown} */
  const value = JSON.parse(text);
  if (!isRecord(value) || value['version'] !== 1 || !Array.isArray(value['rules']))
    throw new Error('Invalid or unsupported dictionary.');
  const rules = new Map();
  const texts = new Set();
  for (const raw of value['rules']) {
    if (!isRecord(raw)) throw new Error('Invalid dictionary rule.');
    const id = raw['id'];
    const text = raw['text'];
    if (
      typeof id !== 'number' ||
      !Number.isSafeInteger(id) ||
      id < 1 ||
      typeof text !== 'string' ||
      text.length === 0 ||
      text.includes('\0') ||
      text !== text.normalize('NFC') ||
      Buffer.from(text, 'utf8').toString('utf8') !== text ||
      typeof raw['enabled'] !== 'boolean' ||
      rules.has(id) ||
      texts.has(text)
    ) {
      throw new Error('Invalid or duplicate dictionary rule.');
    }
    rules.set(id, text);
    texts.add(text);
  }
  return rules;
}

/** Resolve ancestor aliases (such as /var on macOS), but reject a symlink at
 * the output directory itself, including dangling links. Do not create missing
 * directories until the backup's paths have been validated.
 * @param {string} target
 */
function resolveOutputDirectory(target) {
  let current = resolve(target);
  let info = lstatSync(current, { throwIfNoEntry: false });
  if (info?.isSymbolicLink()) throw new Error(`Symlink in output path: ${current}`);

  const missing = [];
  while (info === undefined) {
    missing.push(basename(current));
    current = dirname(current);
    info = lstatSync(current, { throwIfNoEntry: false });
  }
  const existing = realpathSync(current);
  if (!statSync(existing).isDirectory())
    throw new Error(`Not a directory in output path: ${current}`);
  return join(existing, ...missing.reverse());
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
  const dictionary = readDictionary(resolve(inputDir));
  const objectsDir = join(resolve(inputDir), 'objects');
  if (
    !existsSync(objectsDir) ||
    !lstatSync(objectsDir).isDirectory() ||
    lstatSync(objectsDir).isSymbolicLink()
  ) {
    throw new Error('Missing or invalid objects directory. Download the whole backup folder.');
  }
  if (
    readdirSync(resolve(inputDir)).some(
      (name) =>
        name !== 'objects' &&
        name !== KEYCHECK_NAME &&
        (name.startsWith('d1.') || /^[A-Za-z0-9_-]+$/.test(name)),
    )
  ) {
    throw new Error('Flat or mixed backup layout: encoded files must be in objects/.');
  }
  const outputRoot = resolveOutputDirectory(outputDir);
  if (existsSync(outputRoot) && readdirSync(outputRoot).length > 0) {
    throw new Error('Restore into a new or empty output directory to avoid overwriting files.');
  }
  const entries = readdirSync(objectsDir).filter((name) =>
    lstatSync(join(objectsDir, name)).isFile(),
  );

  // Validate every name and collision before writing the first file.
  const paths = new Map();
  const occupied = new Set();
  for (const name of entries) {
    if (name === KEYCHECK_NAME || name === DICTIONARY_NAME || name === DICTIONARY_BACKUP_NAME)
      continue;
    if (name.startsWith('d1.')) throw new Error('Unsupported prefixed object name.');
    if (!/^[A-Za-z0-9_-]+$/.test(name)) continue;
    const path = decodeDriveName(name, dictionary);
    const folded = path.toLowerCase();
    if (occupied.has(folded)) throw new Error(`Duplicate or case-colliding path: ${path}`);
    occupied.add(folded);
    paths.set(name, path);
  }
  for (const path of occupied) {
    const parts = path.split('/');
    parts.pop();
    while (parts.length > 0) {
      if (occupied.has(parts.join('/'))) throw new Error(`File/directory collision: ${path}`);
      parts.pop();
    }
  }

  let passphrase = null;
  let restored = 0;
  let copied = 0;
  let skipped = 0;

  for (const name of entries) {
    if (name === KEYCHECK_NAME || name === DICTIONARY_NAME || name === DICTIONARY_BACKUP_NAME)
      continue;

    const path = paths.get(name);
    if (path === undefined) {
      console.error(`skip  ${name} (not an encoded path name)`);
      skipped += 1;
      continue;
    }

    const bytes = new Uint8Array(readFileSync(join(objectsDir, name)));
    const target = join(outputRoot, path);
    mkdirSync(dirname(target), { recursive: true });

    if (isContainer(bytes)) {
      passphrase ??= await resolvePassphrase(flags);
      writeFileSync(target, await openContainer(bytes, passphrase), { flag: 'wx' });
      console.error(`open  ${path}`);
      restored += 1;
    } else {
      writeFileSync(target, bytes, { flag: 'wx' });
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
