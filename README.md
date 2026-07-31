# Geode

[![CI](https://github.com/lif0/geode-drive-backup/actions/workflows/ci.yml/badge.svg)](https://github.com/lif0/geode-drive-backup/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-%3E%3D1.4.0-7c3aed.svg)](https://obsidian.md)
[![Mobile](https://img.shields.io/badge/mobile-iOS%20%7C%20Android-success.svg)](#)
[![Encryption](https://img.shields.io/badge/encryption-AES--256--GCM-informational.svg)](#encryption)

Backup, not sync. Push your Obsidian vault to **your own** Google Drive, pull it back on a new
device, and optionally encrypt chosen folders before they leave your machine.

Works on desktop and on phones — no Node APIs, no `fetch`, no runtime dependencies.

---

## What it does, and what it deliberately does not

| Does                                          | Does not                                    |
| --------------------------------------------- | ------------------------------------------- |
| Upload files that changed since the last push | Three-way merge                             |
| Rebuild a whole vault on a fresh device       | Real-time or background sync                |
| Encrypt selected paths client-side            | Delete anything locally, ever               |
| Refuse to overwrite another device's edits    | Propagate deletions (unless you turn it on) |
| Report conflicts and move on                  | Keep file history or versions               |

If you need a sync engine, this is the wrong tool. Geode is the thing you run before a risky
change to your vault, and the thing you run on a new laptop.

---

## Install

### From a release

1. Download `main.js` and `manifest.json` from the
   [latest release](https://github.com/lif0/geode-drive-backup/releases).
2. Put them in `<your vault>/.obsidian/plugins/geode-drive-backup/`.
3. Restart Obsidian, then enable **Geode** in _Settings → Community plugins_.

### From source

```bash
git clone https://github.com/lif0/geode-drive-backup.git
cd geode-drive-backup
npm install
npm run build          # typecheck + lint + test + bundle
```

Copy `main.js` and `manifest.json` into your vault's plugin folder, or symlink the repo there and
run `npm run dev` for a watching build.

---

## Setup: your own Google OAuth client

Geode never routes your notes through a third party, so you supply the Google credentials. This is
a one-time, ten-minute job.

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and create a project.
2. **APIs & Services → Library** → enable **Google Drive API**.
3. **APIs & Services → OAuth consent screen** → choose _External_, fill in the required fields, and
   add your own Google account under **Test users**. You do not need to publish the app or submit
   it for review.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
   Choose application type **TVs and Limited Input devices**.
5. Copy the **Client ID** and **Client secret**.
6. In Obsidian: _Settings → Geode_ → paste both, then press **Connect**.
7. A dialog shows a short code and a URL. Open the URL on any device you can type on, enter the
   code, approve access. The dialog closes by itself.

Geode requests exactly one scope: `https://www.googleapis.com/auth/drive.file`. That grants access
only to files this plugin created — it cannot read anything else in your Drive. The broader `drive`
scope is never requested; it is a restricted scope requiring a paid security assessment, and a
backup tool has no business with it.

> **Sign-in fails with "device flow not supported"?**
> Your client is the wrong type. Either recreate it as _TVs and Limited Input devices_, or switch
> **Sign-in method** to _Redirect with PKCE_ in settings. That flow opens a normal Google consent
> page, redirects to a `127.0.0.1` URL that fails to load, and asks you to paste the address bar
> contents back into Obsidian. Ugly, but it needs no local web server, so it works on phones too.

Only the refresh token is written to disk. Access tokens live in memory and are re-derived on
demand.

---

## Usage

Five commands, all from the command palette (`Ctrl/Cmd+P`):

| Command                    | What it does                                                  |
| -------------------------- | ------------------------------------------------------------- |
| **Push changes to Drive**  | Uploads new and changed files. Skips everything else.         |
| **Pull vault from Drive**  | Downloads the whole backup. Never overwrites, never deletes.  |
| **Unlock encryption**      | Validates your passphrase and caches the key for the session. |
| **Connect Google account** | Runs the sign-in flow.                                        |
| **Show backup status**     | Connection, folder, tracked file count, encryption state.     |

### Typical first run

```
Connect Google account   →   Push changes to Drive
```

The first push creates the Drive folder (default name: `Geode`) and uploads everything. Later
pushes upload only what changed.

### Restoring on a new device

```
Install Geode  →  paste the same client ID + secret  →  Connect  →  Pull vault from Drive
```

Pull downloads every file and rebuilds the folder tree from the encoded names. If the vault already
has a file at an incoming path and Geode cannot prove the two are identical, the incoming copy is
written as `note (from drive).md` instead — repeated collisions become `(from drive 2)`,
`(from drive 3)` and so on. **Pull never deletes and never overwrites.**

### Reading the summary

Every run ends with a summary Notice:

```
Push finished: 12 uploaded, 3 updated, 486 unchanged.

2 skipped — changed on another device:
  Journal/2026-07-30.md
  Projects/roadmap.md
```

A **conflict** means the Drive copy changed since this device last wrote it. Geode will not guess
which side wins, so it skips the file and tells you. Resolve it by pulling — you get both copies
side by side — or by deciding manually.

---

## Encryption

Off by default. When on, files whose path matches one of your prefixes are encrypted **before**
they leave the device.

- **Cipher:** AES-256-GCM, fresh random 12-byte nonce per file, per push.
- **Key:** PBKDF2-SHA256, 600,000 iterations, 32-byte key, 16-byte random salt per vault.
- **Container:** `MAGIC "OBEV" | VERSION 0x01 | SALT (16) | NONCE (12) | ciphertext+tag`.

The key is derived once per unlock and cached in memory — deriving it per file would freeze
Obsidian on any real vault. It is cleared when the plugin unloads. The passphrase itself is never
written anywhere.

### Choosing what gets encrypted

One path prefix per line in settings. The rule is deliberately dumb, because a clever rule means a
file you thought was encrypted going up in the clear:

| Prefix     | Matches                                     | Does not match  |
| ---------- | ------------------------------------------- | --------------- |
| `Journal`  | `Journal`, `Journal/2026.md`, `Journal/a/b` | `Journalism.md` |
| `Journal/` | same as above                               | `Journalism.md` |
| `Journal*` | `Journal/2026.md`, `Journalism.md`          | `Diary.md`      |

Matching is case-sensitive, `*` is only special at the end, and lines starting with `#` are ignored.

### The passphrase check file

The first encrypted push writes a small file called `__keycheck` to the Drive folder. It holds the
vault salt and a known marker string. A new device downloads it first and validates your passphrase
against it **before touching any real data** — a wrong passphrase aborts immediately, having
changed nothing on disk.

### Limitations you should know about

- **File names are not encrypted.** Paths are base64url-encoded so Drive accepts them, which is
  encoding, not encryption. Anyone with access to the folder can list every path in your vault.
- **File sizes are not hidden.** A container is the plaintext length plus 49 bytes.
- **There is no recovery.** Forget the passphrase and the encrypted files are gone — for you and
  for everyone else.
- Whether a file is encrypted is decided by the `OBEV` header on download, not by the extension and
  not by the `enc` flag in Drive metadata. Both of those drift; the header does not.

---

## Disaster recovery without Obsidian

`tools/decrypt.mjs` is standalone. It imports nothing from `src/`, needs no `npm install` and no
build step. Copy that one file next to a downloaded Drive folder and you can get your notes back
with nothing but Node and your passphrase.

```bash
# One file to stdout
node tools/decrypt.mjs 5rWL6K-VLm1k

# One file to disk
node tools/decrypt.mjs 5rWL6K-VLm1k -o note.md

# Rebuild a whole vault from a downloaded Drive folder:
# decodes the names, decrypts what is encrypted, copies the rest through
GEODE_PASSPHRASE='…' node tools/decrypt.mjs --dir ./downloaded-Geode --out ./restored

# Prove this tool agrees with the plugin
node tools/decrypt.mjs --verify-vectors test/vectors.json
```

The passphrase comes from `--passphrase`, else `GEODE_PASSPHRASE`, else an interactive prompt.

### Golden vectors

`test/vectors.json` holds four frozen cases — empty file, short ASCII, UTF-8 with Cyrillic and
emoji, and 1 MiB of binary. Each records the passphrase, salt, nonce, plaintext and the exact
expected container.

Two independent implementations must agree on all of them: `src/core/container.ts` (checked by
`npm test`) and `tools/decrypt.mjs` (checked by `npm run verify:vectors`). CI runs both. Vectors are
append-only — changing the format means bumping `VERSION` and adding cases, never editing existing
ones.

---

## How change detection works

Geode decides a file is stale by comparing the SHA-256 of its **plaintext** against a local index in
`data.json`.

This matters more than it sounds. Encrypted files get a fresh nonce on every push, so their
ciphertext — and therefore the Drive `md5Checksum` — changes every single time, even when the note
did not. Any staleness check based on remote checksums would re-upload the entire vault on every
run. The plaintext hash is the only signal that stays still.

The remote md5 is used for exactly one thing: noticing that **another device** rewrote a file since
this one last pushed it. That is a conflict, and Geode refuses to overwrite it.

The plaintext hash never leaves your device. Uploading it for an encrypted file would let anyone
confirm a guess at its contents.

Consequences worth knowing:

- Push reads every file in the vault in order to hash it. Correct, but not free on a vault full of
  large attachments.
- Losing `data.json` is not fatal. The next push sees files it has no record of, finds them already
  on Drive, and reports them as conflicts rather than clobbering them. Pull rebuilds the index.
- `.obsidian/` is never backed up. That is where `data.json` lives — and with it your Google refresh
  token.

### Storage layout in Drive

Flat. One folder, one Drive file per vault file, no mirrored hierarchy:

```
Geode/
  bm90ZS5tZA                    ← base64url("note.md")
  Sm91cm5hbC8yMDI2LTA4LTAxLm1k  ← base64url("Journal/2026-08-01.md")
  __keycheck
```

The path lives in the file name because Drive's `appProperties` cap at roughly 124 bytes per
key/value pair, which any non-ASCII path overflows. `appProperties` carries only `{ v, enc }`.

---

## Settings reference

| Setting                       | Default      | Notes                                                 |
| ----------------------------- | ------------ | ----------------------------------------------------- |
| Client ID / secret            | empty        | Your own Google OAuth client                          |
| Sign-in method                | Device       | Switch to PKCE only if Google rejects the device flow |
| Drive folder name             | `Geode`      | Changing it after a push points at a new folder       |
| Encrypt selected paths        | off          | Enables the prefix list below                         |
| Encrypted paths               | empty        | One prefix per line                                   |
| Ask for the passphrase        | Once/session | Or on every push and pull                             |
| **Mirror deletions to Drive** | **off**      | On, a local delete permanently removes the Drive copy |

> **On mirroring deletions:** with it off, a file you delete locally stays in the backup — which is
> usually the entire point of having one. With it on, pushing deletes the Drive copy permanently,
> bypassing the Drive trash. A backup that forgets what you deleted cannot get it back for you.

---

## Development

```bash
npm run dev             # esbuild watch
npm run typecheck       # tsc across src, test and tools
npm run lint            # eslint, type-aware
npm run test            # vitest over src/core
npm run verify:vectors  # standalone decryptor vs the golden vectors
npm run format
npm run build           # everything, then a production bundle
```

### Layout

```
src/
  main.ts        lifecycle, commands, wiring — no business logic
  types.ts       branded types, Result, AppError
  settings.ts    settings shape, defaults, migration
  core/          pure logic: container, kdf, path-codec, selector, diff, bytes
  drive/         auth-provider, device-flow, pkce-flow, client, dto
  ops/           push, pull, index-store
  ui/            settings-tab, modals, progress
test/            vitest over src/core only — no mocks, no Obsidian stub
tools/           standalone decryptor, vector generator, version bump
```

Two rules the build enforces mechanically rather than by convention:

- **Nothing in `src/core/` may import `obsidian`.** All I/O is injected, which is what lets the
  crypto and diff logic be tested in plain Node with no mocks.
- **Nothing in `src/` may touch Node APIs.** `tsconfig.json` sets `types: []` so `Buffer`,
  `process` and `require` fail to compile, and ESLint bans them plus `fetch` by name. All HTTP goes
  through Obsidian's `requestUrl`, the only thing that gets past CORS in the renderer.

Try it: put `Buffer.from('x')` in any file under `src/` and both `npm run typecheck` and
`npm run lint` will reject it.

---

## License

[Apache-2.0](LICENSE)
