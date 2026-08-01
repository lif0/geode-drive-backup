/**
 * What Geode knows about a path, and how that answer travels up a folder tree.
 *
 * Pure, and separate from the code that draws it, because the rule a folder
 * follows is the part worth being sure about: a folder with one unsaved note in
 * it must not look backed up.
 */

/** The three things a path can be, from the backup's point of view. */
export type BackupState = 'backed-up' | 'pending' | 'excluded';

/**
 * Which state a folder takes when it holds a mixture.
 *
 * Pending is the loud one and wins everything. A folder is only "backed up"
 * when nothing inside it is waiting, and only "excluded" when everything inside
 * it is — the reassuring answers have to be earned by every file below.
 */
const RANK: Record<BackupState, number> = { excluded: 0, 'backed-up': 1, pending: 2 };

/** Every state in rank order, lowest first. */
export const BACKUP_STATES: readonly BackupState[] = ['excluded', 'backed-up', 'pending'];

/**
 * Copies a per-file map and adds an entry for every folder above each file.
 *
 * Folders are not in the input because Obsidian's file list has none: they
 * exist only as prefixes of the paths that are.
 */
export function rollUpFolders(files: ReadonlyMap<string, BackupState>): Map<string, BackupState> {
  const states = new Map<string, BackupState>(files);

  for (const [path, state] of files) {
    const segments = path.split('/');
    for (let depth = 1; depth < segments.length; depth += 1) {
      const folder = segments.slice(0, depth).join('/');
      const current = states.get(folder);
      if (current === undefined || RANK[state] > RANK[current]) states.set(folder, state);
    }
  }

  return states;
}
