/**
 * Plugin settings and the on-disk shape of data.json.
 *
 * data.json holds settings, the Google refresh token and the local index. It is
 * never uploaded, and `.gitignore` keeps it out of the repository.
 */

import type { RunOutcome, RunRecord } from './core/history';
import { HISTORY_LIMIT } from './core/history';

/** When Geode asks for the encryption passphrase. */
export type PassphrasePrompt = 'once-per-session' | 'every-operation';

/** Which OAuth flow to use. Device is the default; PKCE is the fallback. */
export type AuthFlowKind = 'device' | 'pkce';

/** An index entry as stored in JSON, before branding. */
export interface StoredIndexEntry {
  sha256: string;
  driveFileId: string;
  remoteMd5: string;
  mtime: number;
  /** `-1` in entries written before this field existed. */
  size: number;
}

/** Everything Geode persists. */
export interface GeodeSettings {
  clientId: string;
  clientSecret: string;
  /** The only credential kept on disk. Access tokens stay in memory. */
  refreshToken: string | null;
  authFlow: AuthFlowKind;
  folderName: string;
  /** Cached id of the Drive app folder, so we do not search for it every run. */
  folderId: string | null;
  /**
   * Read the vault's own root `.gitignore` and skip what it excludes.
   *
   * Off by default. Turning it on shrinks what gets backed up, and a backup
   * tool must never do that on the user's behalf.
   */
  useGitignore: boolean;
  /**
   * Extra exclusion lines in `.gitignore` syntax, applied after the file's own,
   * so a `!` here can bring back something the repository excluded.
   */
  excludedPaths: string[];
  /** Mark files and folders in Obsidian's file explorer with their backup state. */
  showFileBadges: boolean;
  encryptionEnabled: boolean;
  /** Vault path prefixes whose files are encrypted before upload. */
  encryptedPrefixes: string[];
  passphrasePrompt: PassphrasePrompt;
  /** Off by default: turning it on lets a local delete erase the Drive copy. */
  mirrorDeletions: boolean;
  index: Record<string, StoredIndexEntry>;
  /** The last few finished runs, newest first. Read by the panel's History tab. */
  history: RunRecord[];
  schemaVersion: number;
}

/** Bump when a field changes meaning, and handle the old shape in migrateSettings. */
export const SETTINGS_SCHEMA_VERSION = 1;

/** Factory defaults. `satisfies` makes a missing or misspelled key a compile error. */
export const DEFAULT_SETTINGS = {
  clientId: '',
  clientSecret: '',
  refreshToken: null,
  authFlow: 'device',
  folderName: 'GeodeDrive',
  folderId: null,
  useGitignore: false,
  excludedPaths: [],
  showFileBadges: true,
  encryptionEnabled: false,
  encryptedPrefixes: [],
  passphrasePrompt: 'once-per-session',
  mirrorDeletions: false,
  index: {},
  history: [],
  schemaVersion: SETTINGS_SCHEMA_VERSION,
} satisfies GeodeSettings;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string, fallback: string): string {
  const value = source[key];
  return typeof value === 'string' ? value : fallback;
}

function readNullableString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readBoolean(source: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = source[key];
  return typeof value === 'boolean' ? value : fallback;
}

function readStringArray(source: Record<string, unknown>, key: string): string[] {
  const value = source[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function readIndex(source: Record<string, unknown>, key: string): Record<string, StoredIndexEntry> {
  const value = source[key];
  if (!isRecord(value)) return {};
  const out: Record<string, StoredIndexEntry> = {};
  for (const [path, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue;
    const sha256 = raw['sha256'];
    const driveFileId = raw['driveFileId'];
    const remoteMd5 = raw['remoteMd5'];
    const mtime = raw['mtime'];
    const size = raw['size'];
    if (typeof sha256 !== 'string' || typeof driveFileId !== 'string') continue;
    out[path] = {
      sha256,
      driveFileId,
      remoteMd5: typeof remoteMd5 === 'string' ? remoteMd5 : '',
      mtime: typeof mtime === 'number' ? mtime : 0,
      // An older entry has no size, so the hash cache must miss on it.
      size: typeof size === 'number' ? size : -1,
    };
  }
  return out;
}

function readNumber(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

const RUN_OUTCOMES: readonly RunOutcome[] = ['ok', 'partial', 'cancelled', 'failed'];

/**
 * Reads the run log, dropping anything malformed.
 *
 * A record with no timestamp cannot be placed in the list or the activity chart,
 * so it is thrown away rather than shown at the epoch. The log is truncated on
 * the way in as well as on the way out, so a hand-edited data.json cannot leave
 * the panel drawing ten thousand rows.
 */
function readHistory(source: Record<string, unknown>, key: string): RunRecord[] {
  const value = source[key];
  if (!Array.isArray(value)) return [];

  const history: RunRecord[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;

    const at = readNumber(raw, 'at');
    if (at <= 0) continue;

    const outcome = raw['outcome'];
    history.push({
      at,
      operation: raw['operation'] === 'pull' ? 'pull' : 'push',
      outcome: RUN_OUTCOMES.find((known) => known === outcome) ?? 'ok',
      files: readNumber(raw, 'files'),
      bytes: readNumber(raw, 'bytes'),
      durationMs: readNumber(raw, 'durationMs'),
      conflicts: readNumber(raw, 'conflicts'),
      failures: readNumber(raw, 'failures'),
      message: readString(raw, 'message', ''),
    });
  }

  return history.slice(0, HISTORY_LIMIT);
}

/** A fresh copy of the defaults, safe to mutate. */
export function defaultSettings(): GeodeSettings {
  return {
    ...DEFAULT_SETTINGS,
    excludedPaths: [],
    encryptedPrefixes: [],
    index: {},
    history: [],
  };
}

/**
 * Turns whatever `plugin.loadData()` returned into valid settings.
 *
 * Nothing is trusted: data.json is user-editable and may be from an older
 * version. Unrecognised or malformed fields fall back to their default rather
 * than failing the load, because refusing to start would strand the user's
 * refresh token.
 */
export function migrateSettings(raw: unknown): GeodeSettings {
  if (!isRecord(raw)) return defaultSettings();

  const authFlowRaw = raw['authFlow'];
  const authFlow: AuthFlowKind = authFlowRaw === 'pkce' ? 'pkce' : 'device';

  const promptRaw = raw['passphrasePrompt'];
  const passphrasePrompt: PassphrasePrompt =
    promptRaw === 'every-operation' ? 'every-operation' : 'once-per-session';

  const folderName = readString(raw, 'folderName', DEFAULT_SETTINGS.folderName);

  return {
    clientId: readString(raw, 'clientId', '').trim(),
    clientSecret: readString(raw, 'clientSecret', '').trim(),
    refreshToken: readNullableString(raw, 'refreshToken'),
    authFlow,
    folderName: folderName.trim().length > 0 ? folderName.trim() : DEFAULT_SETTINGS.folderName,
    folderId: readNullableString(raw, 'folderId'),
    useGitignore: readBoolean(raw, 'useGitignore', false),
    excludedPaths: readStringArray(raw, 'excludedPaths'),
    showFileBadges: readBoolean(raw, 'showFileBadges', true),
    encryptionEnabled: readBoolean(raw, 'encryptionEnabled', false),
    encryptedPrefixes: readStringArray(raw, 'encryptedPrefixes'),
    passphrasePrompt,
    mirrorDeletions: readBoolean(raw, 'mirrorDeletions', false),
    index: readIndex(raw, 'index'),
    history: readHistory(raw, 'history'),
    schemaVersion: SETTINGS_SCHEMA_VERSION,
  };
}

/** True once the user has pasted both halves of their OAuth client. */
export function hasClientCredentials(settings: GeodeSettings): boolean {
  return settings.clientId.length > 0 && settings.clientSecret.length > 0;
}
