import { describe, expect, it } from 'vitest';

import { buildEditorDirectoryEntries } from '@desktop/renderer/editorTree';

describe('desktop editor tree', () => {
  it('sorts one directory listing with folders before files', () => {
    const nodes = buildEditorDirectoryEntries([
      { path: 'README.md', isDirectory: false },
      { path: 'src', isDirectory: true },
      { path: 'assets', isDirectory: true },
      { path: 'package.json', isDirectory: false },
    ]);

    expect(nodes).toEqual([
      {
        kind: 'directory',
        name: 'assets',
        path: 'assets',
        children: [],
      },
      {
        kind: 'directory',
        name: 'src',
        path: 'src',
        children: [],
      },
      {
        kind: 'file',
        name: 'package.json',
        path: 'package.json',
      },
      {
        kind: 'file',
        name: 'README.md',
        path: 'README.md',
      },
    ]);
  });

  it('normalizes path separators and names nested direct children', () => {
    const nodes = buildEditorDirectoryEntries([
      { path: String.raw`docs\paper`, isDirectory: true },
      { path: './docs/notes.md', isDirectory: false },
    ]);

    expect(nodes).toEqual([
      {
        kind: 'directory',
        name: 'paper',
        path: 'docs/paper',
        children: [],
      },
      {
        kind: 'file',
        name: 'notes.md',
        path: 'docs/notes.md',
      },
    ]);
  });
});
