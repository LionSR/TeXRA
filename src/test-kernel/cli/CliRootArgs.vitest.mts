import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  collectStringFlagValues,
  expandWorkflowInputSpecs,
  normalizeRootShortcuts,
  reorderGlobalFlags,
  resolveLoginProvider,
} from '../../../packages/cli/src/commands/root';

describe('CLI root argument routing', () => {
  it('routes top-level --logout to the logout subcommand', () => {
    expect(normalizeRootShortcuts(['--logout'])).toEqual(['logout']);
  });

  it('preserves global flags when routing top-level --logout', () => {
    expect(
      normalizeRootShortcuts(['--output-format', 'json', '--logout']),
    ).toEqual(['logout', '--output-format', 'json']);
  });

  it('does not rewrite subcommand-scoped --logout flags', () => {
    expect(normalizeRootShortcuts(['chat', '--logout'])).toEqual([
      'chat',
      '--logout',
    ]);
  });

  it('does not rewrite unknown leading flags before --logout', () => {
    expect(normalizeRootShortcuts(['--unknown', '--logout'])).toEqual([
      '--unknown',
      '--logout',
    ]);
  });

  it('keeps leading global flags attached to explicit subcommands', () => {
    expect(reorderGlobalFlags(['--output-format', 'json', 'auth'])).toEqual([
      'auth',
      '--output-format',
      'json',
    ]);
  });

  it('keeps leading api-mode flags attached to explicit subcommands', () => {
    expect(
      reorderGlobalFlags(['--api-mode', 'personal', 'run', 'polish']),
    ).toEqual(['run', 'polish', '--api-mode', 'personal']);
  });

  it('keeps unknown leading flags in place for citty to report', () => {
    expect(reorderGlobalFlags(['--unknown', 'auth'])).toEqual([
      '--unknown',
      'auth',
    ]);
  });

  it('collects repeated run context flags from raw args', () => {
    expect(
      collectStringFlagValues(
        [
          'firstread',
          '-i',
          'appendix.tex',
          '-c',
          'paper.tex',
          '--context=bib.tex',
        ],
        'context',
        'c',
      ),
    ).toEqual(['paper.tex', 'bib.tex']);
  });

  it('collects repeated run input flags from raw args', () => {
    expect(
      collectStringFlagValues(
        ['firstread', '--input=Draft0.tex', '-i', 'appendices.tex'],
        'input',
        'i',
      ),
    ).toEqual(['Draft0.tex', 'appendices.tex']);
  });

  it('expands workflow input directories and globs relative to cwd', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'texra-cli-inputs-'));
    try {
      await fs.mkdir(path.join(root, 'paper', 'sections'), {
        recursive: true,
      });
      await fs.writeFile(path.join(root, 'paper', 'Draft0.tex'), 'draft');
      await fs.writeFile(
        path.join(root, 'paper', 'sections', 'appendix.tex'),
        'appendix',
      );
      await fs.writeFile(path.join(root, 'paper', 'notes.md'), 'notes');

      await expect(expandWorkflowInputSpecs(['paper'], root)).resolves.toEqual([
        'paper/Draft0.tex',
        'paper/sections/appendix.tex',
      ]);
      await expect(
        expandWorkflowInputSpecs(['paper/**/*.tex'], root),
      ).resolves.toEqual(['paper/Draft0.tex', 'paper/sections/appendix.tex']);
      await expect(
        expandWorkflowInputSpecs(
          [path.join(root, 'paper', 'sections', 'appendix.tex')],
          root,
        ),
      ).resolves.toEqual(['paper/sections/appendix.tex']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('CLI login arguments', () => {
  it('prefers explicit provider flags over positional providers', () => {
    expect(resolveLoginProvider('google', 'github')).toBe('github');
  });
});
