import { describe, expect, it } from 'vitest';

import { buildPathTree } from '../src/core/path-tree';
import type { TreeNode } from '../src/core/path-tree';

function entry(path: string, size = 10): { path: string; size: number } {
  return { path, size };
}

/** The tree as `name(files,bytes)` lines, indented, so a test reads like one. */
function outline(nodes: readonly TreeNode[], depth = 0): string[] {
  return nodes.flatMap((node) => [
    `${'  '.repeat(depth)}${node.name}(${String(node.files)},${String(node.bytes)})`,
    ...outline(node.children, depth + 1),
  ]);
}

describe('buildPathTree', () => {
  it('returns nothing for nothing', () => {
    expect(buildPathTree([])).toEqual([]);
  });

  it('nests paths into folders', () => {
    const tree = buildPathTree([entry('a/b/one.md'), entry('a/b/two.md'), entry('a/three.md')]);
    expect(outline(tree)).toEqual([
      'a(3,30)',
      '  b(2,20)',
      '    one.md(1,10)',
      '    two.md(1,10)',
      '  three.md(1,10)',
    ]);
  });

  it('rolls counts and bytes up through every folder', () => {
    const tree = buildPathTree([entry('deep/a/b/c/file.bin', 500)]);
    expect(outline(tree)).toEqual([
      'deep(1,500)',
      '  a(1,500)',
      '    b(1,500)',
      '      c(1,500)',
      '        file.bin(1,500)',
    ]);
  });

  it('keeps a file at the vault root at the top level', () => {
    const tree = buildPathTree([entry('note.md')]);
    expect(tree.map((node) => node.name)).toEqual(['note.md']);
    expect(tree[0]?.children).toEqual([]);
  });

  it('carries the full path on every node', () => {
    const tree = buildPathTree([entry('a/b/c.md')]);
    expect(tree[0]?.path).toBe('a');
    expect(tree[0]?.children[0]?.path).toBe('a/b');
    expect(tree[0]?.children[0]?.children[0]?.path).toBe('a/b/c.md');
  });

  it('puts folders before files, heaviest first', () => {
    // Weight is what an exclusion list is read for: sorting by name would be
    // easier to scan and would bury the folder that is actually costing you.
    const tree = buildPathTree([
      entry('small.md', 1),
      entry('huge.bin', 9000),
      entry('light/a.md', 5),
      entry('heavy/a.bin', 100),
    ]);
    expect(tree.map((node) => node.name)).toEqual(['heavy', 'light', 'huge.bin', 'small.md']);
  });

  it('breaks ties by name, so the same input always draws the same tree', () => {
    const tree = buildPathTree([entry('b.md', 10), entry('a.md', 10), entry('c.md', 10)]);
    expect(tree.map((node) => node.name)).toEqual(['a.md', 'b.md', 'c.md']);
  });

  it('ignores empty and stray-slash segments', () => {
    expect(outline(buildPathTree([entry('a//b.md')]))).toEqual(['a(1,10)', '  b.md(1,10)']);
    expect(buildPathTree([entry('')])).toEqual([]);
  });
});
