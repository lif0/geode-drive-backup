import { planPush } from '../core/diff';
import { isIgnored } from '../core/ignore';
import type { DriveQuota } from '../drive/client';
import type { GeodeSettings } from '../settings';
import type { Result, VaultIo, VaultPath } from '../types';
import { ok } from '../types';
import { resolveFolder } from './folder';
import type { PushDeps } from './push';
import { collectLocalFiles, loadIgnoreRules } from './push';

/**
 * A dry run: what a push would do, and whether Drive has room for it.
 *
 * Nothing is uploaded, nothing is written to the index, and the passphrase is
 * never asked for — an estimate encrypts nothing, so it has no business holding
 * the key. The one thing it can write is the Drive folder id into settings, if
 * resolving the folder had to go and find it.
 *
 * It is not free, though. Working out what changed means the same walk a push
 * begins with: stat every file, read the ones whose size or timestamp moved.
 * That is why it happens on a button rather than whenever the panel opens.
 */

/** What a push would do right now. */
export interface PushEstimate {
  /** Files Drive has never seen. */
  readonly uploads: number;
  /** Files Drive has, with different contents here. */
  readonly updates: number;
  /** Bytes those two would send, measured as plaintext. */
  readonly bytes: number;
  /** Files another device rewrote. A push reports these and moves on. */
  readonly conflicts: number;
  readonly unchanged: number;
  /** Files an exclusion rule keeps out of the backup. */
  readonly excluded: number;
  /** Drive copies a push would remove, which is zero unless mirroring is on. */
  readonly deletions: number;
}

/** What the backup looks like from here. */
export interface BackupEstimate {
  readonly push: PushEstimate;
  /** The Drive folder as it stands. */
  readonly remote: { readonly files: number; readonly bytes: number };
  /** Null when Drive would not say — an account with no limit, or a failure. */
  readonly quota: DriveQuota | null;
}

/**
 * Works out what a push would do without doing any of it.
 *
 * The quota is best-effort: a backup tool that refuses to tell you what it is
 * about to upload because it could not read a storage figure has its priorities
 * backwards.
 */
export async function estimateBackup(deps: PushDeps): Promise<Result<BackupEstimate>> {
  const folderId = await resolveFolder(deps);
  if (!folderId.ok) return folderId;

  const listing = await deps.drive.listFolder(folderId.value);
  if (!listing.ok) return listing;

  const ignore = await loadIgnoreRules(deps);
  const collected = await collectLocalFiles(deps, ignore);
  if (!collected.ok) return collected;

  const plan = planPush(collected.value.files, deps.index.snapshot(), listing.value.files, {
    encryptionEnabled: deps.settings.encryptionEnabled,
    encryptedPrefixes: deps.settings.encryptedPrefixes,
    mirrorDeletions: deps.settings.mirrorDeletions,
    ignore,
  });

  const sizeOf = new Map(collected.value.files.map((file) => [file.path, file.size]));

  // Counted in one walk rather than with a filter per field.
  const counters = {
    uploads: 0,
    updates: 0,
    bytes: 0,
    conflicts: 0,
    unchanged: 0,
    excluded: collected.value.excluded,
    deletions: 0,
  };

  for (const action of plan.actions) {
    switch (action.type) {
      case 'upload':
        counters.uploads += 1;
        counters.bytes += sizeOf.get(action.path) ?? 0;
        break;
      case 'update':
        counters.updates += 1;
        counters.bytes += sizeOf.get(action.path) ?? 0;
        break;
      case 'conflict':
        counters.conflicts += 1;
        break;
      case 'delete-remote':
        counters.deletions += 1;
        break;
      case 'skip':
        // Only a file that is really still there and really unchanged counts.
        // A skip for an excluded path, or for one deleted locally and kept on
        // Drive, is a different thing and has its own line.
        if (action.reason === 'unchanged' || action.reason === 'remote-changed-locally-unchanged') {
          counters.unchanged += 1;
        }
        break;
    }
  }

  const quota = await deps.drive.storageQuota();

  return ok({
    push: counters,
    remote: {
      files: listing.value.files.length,
      bytes: listing.value.files.reduce((total, file) => total + file.size, 0),
    },
    quota: quota.ok ? quota.value : null,
  });
}

/** One file an exclusion rule keeps out of the backup. */
export interface ExcludedFile {
  readonly path: VaultPath;
  readonly size: number;
}

/** What the exclusion rules would do to this vault. */
export interface ExclusionPreview {
  /** Files Obsidian tracks here. */
  readonly total: number;
  /** Every excluded path, not a sample: the tree view needs all of them. */
  readonly excluded: readonly ExcludedFile[];
  /** Bytes those add up to — the reason most people exclude anything. */
  readonly bytes: number;
}

/**
 * Applies the exclusion rules and reports what they catch.
 *
 * Cheap, unlike `estimateBackup`: it stats the vault and matches paths, and
 * never opens a file or touches the network. An exclusion rule is invisible by
 * design — the file is simply not there the day it is wanted — so being able to
 * ask what one does, without doing anything, is what makes it safe to write.
 */
export async function previewExclusions(deps: {
  readonly vault: VaultIo;
  readonly settings: GeodeSettings;
}): Promise<ExclusionPreview> {
  const ignore = await loadIgnoreRules(deps);
  const all = await deps.vault.listFiles();

  const excluded: ExcludedFile[] = [];
  let bytes = 0;
  for (const stat of all) {
    if (!isIgnored(ignore, stat.path)) continue;
    excluded.push({ path: stat.path, size: stat.size });
    bytes += stat.size;
  }

  return { total: all.length, excluded, bytes };
}
