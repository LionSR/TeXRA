import * as assert from 'node:assert';

import { describe, it } from 'vitest';

import {
  acceptEditedFileReplace,
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
});
