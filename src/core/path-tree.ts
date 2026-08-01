/**
 * Flat paths to a folder tree, with sizes rolled up.
 *
 * A list of two and a half thousand excluded paths is not something a person
 * can read. The same paths as a tree, with each folder carrying the count and
 * the weight of everything beneath it, answers the only question worth asking
 * of an exclusion list — "is any of this something I wanted?" — in one glance
 * at the top level.
 *
 * Pure, so the shape of the answer can be tested without a vault.
 */

/** One path going in. */
export interface TreeEntry {
  readonly path: string;
  readonly size: number;
}

/** A folder or a file. Folders are the ones with children. */
export interface TreeNode {
  readonly name: string;
  /** Full vault path of this node. */
  readonly path: string;
  readonly children: readonly TreeNode[];
  /** Files at or below here. 1 for a file. */
  readonly files: number;
  /** Bytes at or below here. */
  readonly bytes: number;
}

interface Builder {
  readonly name: string;
  readonly path: string;
  readonly children: Map<string, Builder>;
  files: number;
  bytes: number;
}

/**
 * Heaviest first, folders before files.
 *
 * Sorting by name would make the list easy to scan and useless to act on: what
 * matters about an exclusion is how much it is keeping out of the backup, and
 * that is almost always concentrated in two or three folders. Name is the
 * tie-break, so the same input always produces the same tree.
 */
function compareNodes(a: TreeNode, b: TreeNode): number {
  const aFolder = a.children.length > 0;
  const bFolder = b.children.length > 0;
  if (aFolder !== bFolder) return aFolder ? -1 : 1;
  if (a.bytes !== b.bytes) return b.bytes - a.bytes;
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
}

function freeze(builder: Builder): TreeNode {
  const children = [...builder.children.values()].map(freeze).sort(compareNodes);
  return {
    name: builder.name,
    path: builder.path,
    children,
    files: builder.files,
    bytes: builder.bytes,
  };
}

/** Builds the tree. Returns the top-level nodes, not a synthetic root. */
export function buildPathTree(entries: readonly TreeEntry[]): readonly TreeNode[] {
  const root: Builder = { name: '', path: '', children: new Map(), files: 0, bytes: 0 };

  for (const entry of entries) {
    const segments = entry.path.split('/').filter((segment) => segment.length > 0);
    if (segments.length === 0) continue;

    let node = root;
    for (let depth = 0; depth < segments.length; depth += 1) {
      const name = segments[depth] ?? '';
      let child = node.children.get(name);
      if (child === undefined) {
        child = {
          name,
          path: segments.slice(0, depth + 1).join('/'),
          children: new Map(),
          files: 0,
          bytes: 0,
        };
        node.children.set(name, child);
      }
      // Every folder on the way down carries the file, which is what makes a
      // collapsed folder able to say how much is under it.
      child.files += 1;
      child.bytes += entry.size;
      node = child;
    }
  }

  return freeze(root).children;
}
