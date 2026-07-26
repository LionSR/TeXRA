// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - desktop renderer
import { buildEditorTree } from '@desktop/renderer/editorTree';

describe('desktop editor tree', () => {
  it('groups workspace files into sorted nested directories', () => {
    const tree = buildEditorTree([
      { path: 'README.md', isDirectory: false },
      { path: 'src/view/Panel.ts', isDirectory: false },
      { path: 'src/index.ts', isDirectory: false },
      { path: 'assets/logo.svg', isDirectory: false },
      { path: 'package.json', isDirectory: false },
    ]);

    expect(tree.nodes).toEqual([
      {
        kind: 'directory',
        name: 'assets',
        path: 'assets',
        children: [
          {
            kind: 'file',
            name: 'logo.svg',
            path: 'assets/logo.svg',
          },
        ],
      },
      {
        kind: 'directory',
        name: 'src',
        path: 'src',
        children: [
          {
            kind: 'directory',
            name: 'view',
            path: 'src/view',
            children: [
              {
                kind: 'file',
                name: 'Panel.ts',
                path: 'src/view/Panel.ts',
              },
            ],
          },
          {
            kind: 'file',
            name: 'index.ts',
            path: 'src/index.ts',
          },
        ],
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
    expect([...tree.directoryPaths]).toEqual(['src', 'src/view', 'assets']);
  });

  it('normalizes directory keys while preserving file paths used by IPC', () => {
    const tree = buildEditorTree([
      { path: String.raw`docs\paper\main.tex`, isDirectory: false },
      { path: 'docs/figures', isDirectory: true },
      { path: './notes.md', isDirectory: false },
    ]);

    expect(tree.directoryPaths).toEqual(
      new Set(['docs', 'docs/paper', 'docs/figures']),
    );
    expect(tree.nodes).toMatchObject([
      {
        name: 'docs',
        children: [
          { name: 'figures', children: [] },
          {
            name: 'paper',
            children: [
              {
                name: 'main.tex',
                path: String.raw`docs\paper\main.tex`,
              },
            ],
          },
        ],
      },
      { name: 'notes.md', path: './notes.md' },
    ]);
  });
});
