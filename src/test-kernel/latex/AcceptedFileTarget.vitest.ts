import * as assert from 'node:assert';

import { describe, it } from 'vitest';

import {
  acceptEditedFileReplace,
  cleanupStaleDiffFile,
  diffFileLocation,
  type AcceptEditedFileReplacePorts,
} from '@latex/acceptedFileTarget';
import type { FileLocation } from '@shared/schemas';
import { createWorkspaceLocation } from '@utils/files';

describe('diffFileLocation', () => {
  it('computes the stale _diff sibling for a base/edited pair', () => {
    const base = createWorkspaceLocation(
      '/ws/chapters/paper.tex',
      'chapters/paper.tex',
    );

    const loc = diffFileLocation(base, '/ws/chapters/paper_correct.tex');

    assert.strictEqual(loc.kind, 'workspace');
    assert.strictEqual(loc.absolutePath, '/ws/chapters/paper_correct_diff.tex');
    if (loc.kind === 'workspace') {
      assert.strictEqual(loc.relativePath, 'chapters/paper_correct_diff.tex');
    }
  });
});

describe('cleanupStaleDiffFile', () => {
  it('deletes the derived diff location when it differs from the target', async () => {
    const base = createWorkspaceLocation('/ws/paper.tex', 'paper.tex');
    const deleted: FileLocation[] = [];

    await cleanupStaleDiffFile(
      base,
      '/ws/paper_correct.tex',
      base,
      async (location) => {
        deleted.push(location);
      },
    );

    assert.strictEqual(deleted.length, 1);
    assert.strictEqual(deleted[0].absolutePath, '/ws/paper_correct_diff.tex');
  });

  it('skips deletion when the derived diff location is the accept target', async () => {
    const base = createWorkspaceLocation(
      '/ws/paper_diff.tex',
      'paper_diff.tex',
    );
    const deleted: FileLocation[] = [];

    await cleanupStaleDiffFile(
      base,
      '/ws/paper.tex',
      base,
      async (location) => {
        deleted.push(location);
      },
    );

    assert.strictEqual(deleted.length, 0);
  });

  it('skips deletion when the target is not the base itself (copy/sibling write)', async () => {
    const base = createWorkspaceLocation('/ws/paper.tex', 'paper.tex');
    const sibling = createWorkspaceLocation(
      '/ws/paper_copy.tex',
      'paper_copy.tex',
    );
    const deleted: FileLocation[] = [];

    await cleanupStaleDiffFile(
      base,
      '/ws/paper_correct.tex',
      sibling,
      async (location) => {
        deleted.push(location);
      },
    );

    assert.strictEqual(deleted.length, 0);
  });
});

describe('acceptEditedFileReplace', () => {
  function buildPorts(
    overrides: Partial<AcceptEditedFileReplacePorts> = {},
  ): AcceptEditedFileReplacePorts & { deleted: FileLocation[] } {
    const deleted: FileLocation[] = [];
    return {
      exists: async () => false,
      readFile: async () => 'edited content',
      writeFile: async () => undefined,
      confirm: async () => true,
      emitWritten: () => undefined,
      showInfo: async () => undefined,
      deleteFile: async (location) => {
        deleted.push(location);
      },
      deleted,
      ...overrides,
    };
  }

  it('cleans up the stale diff file after a successful accept', async () => {
    const base = createWorkspaceLocation('/ws/paper.tex', 'paper.tex');
    const edited = createWorkspaceLocation(
      '/ws/paper_correct.tex',
      'paper_correct.tex',
    );
    const ports = buildPorts();

    const accepted = await acceptEditedFileReplace(base, edited, ports);

    assert.strictEqual(accepted, true);
    assert.strictEqual(ports.deleted.length, 1);
    assert.strictEqual(
      ports.deleted[0].absolutePath,
      '/ws/paper_correct_diff.tex',
    );
  });

  it('does not clean up when the user declines the confirmation', async () => {
    const base = createWorkspaceLocation('/ws/paper.tex', 'paper.tex');
    const edited = createWorkspaceLocation(
      '/ws/paper_correct.tex',
      'paper_correct.tex',
    );
    const ports = buildPorts({ confirm: async () => false });

    const accepted = await acceptEditedFileReplace(base, edited, ports);

    assert.strictEqual(accepted, false);
    assert.strictEqual(ports.deleted.length, 0);
  });

  it('does not delete the just-accepted file when it collides with the derived diff name', async () => {
    // base is literally named "<edited-stem>_diff.tex" — the same name
    // diffFileLocation would derive for this edited/base pair — so the
    // write target and the "stale diff" coincide.
    const base = createWorkspaceLocation(
      '/ws/paper_diff.tex',
      'paper_diff.tex',
    );
    const edited = createWorkspaceLocation('/ws/paper.tex', 'paper.tex');
    const ports = buildPorts();

    const accepted = await acceptEditedFileReplace(base, edited, ports);

    assert.strictEqual(accepted, true);
    assert.strictEqual(ports.deleted.length, 0);
  });

  it('does not clean up the base diff when accepting into a new sibling (extension mismatch)', async () => {
    // Different extensions -> getAcceptedFileTarget resolves to a new
    // sibling file, leaving base untouched, so its diff is still accurate.
    const base = createWorkspaceLocation('/ws/paper.tex', 'paper.tex');
    const edited = createWorkspaceLocation('/ws/notes.md', 'notes.md');
    const ports = buildPorts();

    const accepted = await acceptEditedFileReplace(base, edited, ports);

    assert.strictEqual(accepted, true);
    assert.strictEqual(ports.deleted.length, 0);
  });
});
