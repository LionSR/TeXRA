import { describe, expect, it } from 'vitest';

import { buildEditorDirectoryEntries } from '@desktop/renderer/editorTree';

describe('desktop editor tree', () => {
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
