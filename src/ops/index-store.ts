import type { DriveFileId, IndexEntry, LocalIndex, Sha256Hex, VaultPath } from '../types';
import { driveFileId, isValidSha256Hex, isValidVaultPath, sha256Hex, vaultPath } from '../types';
import type { StoredIndexEntry } from '../settings';

/**
 * The local index: what Geode last pushed, per path.
 *
 * Lives in data.json and is never uploaded. It holds the PLAINTEXT hash of every
 * file, which for an encrypted file is exactly the thing that must not reach
 * Drive — knowing it lets anyone confirm a guess at the contents.
 */

/**
 * Reads the index out of the stored JSON, dropping anything malformed.
 *
 * An unreadable entry is discarded rather than fatal. The cost of a lost entry
 * is one redundant upload, or a conflict report; the cost of refusing to load is
 * a plugin that will not start.
 */
export function readIndex(stored: Record<string, StoredIndexEntry>): LocalIndex {
  const index: LocalIndex = {};

  for (const [path, entry] of Object.entries(stored)) {
    if (!isValidVaultPath(path)) continue;
    if (!isValidSha256Hex(entry.sha256)) continue;
    if (entry.driveFileId.length === 0) continue;

    index[vaultPath(path)] = {
      sha256: sha256Hex(entry.sha256),
      driveFileId: driveFileId(entry.driveFileId),
      remoteMd5: entry.remoteMd5,
      mtime: entry.mtime,
      size: entry.size,
    };
  }

  return index;
}

/** Flattens the index back to the plain JSON shape data.json holds. */
export function writeIndex(index: LocalIndex): Record<string, StoredIndexEntry> {
  const stored: Record<string, StoredIndexEntry> = {};

  for (const [path, entry] of Object.entries(index)) {
    stored[path] = {
      sha256: entry.sha256,
      driveFileId: entry.driveFileId,
      remoteMd5: entry.remoteMd5,
      mtime: entry.mtime,
      size: entry.size,
    };
  }

  return stored;
}

/**
 * The in-memory index during a push or pull.
 *
 * Mutations are collected here and persisted once at the end, so a run that dies
 * halfway leaves the index describing the last known-good state rather than a
 * half-updated one.
 */
export class IndexStore {
  private index: LocalIndex;

  constructor(
    stored: Record<string, StoredIndexEntry>,
    private readonly persist: (stored: Record<string, StoredIndexEntry>) => Promise<void>,
  ) {
    this.index = readIndex(stored);
  }

  /** The current index. Treat as read-only. */
  snapshot(): LocalIndex {
    return this.index;
  }

  /** What Geode knows about one path, or undefined. */
  get(path: VaultPath): IndexEntry | undefined {
    return this.index[path];
  }

  /** Records a successful upload, update or download. */
  set(
    path: VaultPath,
    entry: {
      sha256: Sha256Hex;
      driveFileId: DriveFileId;
      remoteMd5: string;
      mtime: number;
      size: number;
    },
  ): void {
    this.index[path] = { ...entry };
  }

  /** Forgets a path, after the Drive copy is deleted or found missing. */
  remove(path: VaultPath): void {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- keys are vault paths, not a fixed set
    delete this.index[path];
  }

  /** Throws the whole index away. Used before a pull rebuilds it. */
  clear(): void {
    this.index = {};
  }

  /** Number of tracked files. */
  size(): number {
    return Object.keys(this.index).length;
  }

  /** Writes the index to data.json. */
  async save(): Promise<void> {
    await this.persist(writeIndex(this.index));
  }
}
