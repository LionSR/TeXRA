import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assertWorkflowFilesExist } from '@tools/delegation/inputFields';
import { WorkspaceFS } from '@utils/files/workspaceFS';

const originalExists = WorkspaceFS.exists;

describe('assertWorkflowFilesExist', () => {
  beforeEach(() => {
    WorkspaceFS.exists = async (file) => file !== 'missing.tex';
  });

  afterEach(() => {
    WorkspaceFS.exists = originalExists;
  });

  it('accepts present files across all workflow input groups', async () => {
    await expect(
      assertWorkflowFilesExist([
        { label: 'Input file', files: ['paper.tex'] },
        { label: 'Context file', files: ['notes.md'] },
        { label: 'Media file', files: ['figure.pdf'] },
      ]),
    ).resolves.toBeUndefined();
  });

  it('reports the first missing file with its group label', async () => {
    await expect(
      assertWorkflowFilesExist([
        { label: 'Input file', files: ['paper.tex', 'missing.tex'] },
        { label: 'Context file', files: ['notes.md'] },
      ]),
    ).rejects.toThrow('Input file not found: missing.tex');
  });
});
