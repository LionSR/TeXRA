// Node.js built-in imports
import * as assert from 'assert';

// Platform imports
import { FileType, type FileStat } from '@platform/interfaces/filesystem';

// Local imports - tools
import {
  rejectOversizedBibAttachments,
  type WorkflowAgentInput,
} from '@tools/DelegationTools';
import { WorkspaceFS } from '@utils/files';

const BASE_INPUT: WorkflowAgentInput = {
  agent: 'criticize',
  model: 'opus47T',
  instruction: 'Review the manuscript.',
  inputFile: 'main.tex',
  inputFiles: [],
  contextFile: null,
  contextFiles: [],
  mediaFile: null,
  mediaFiles: [],
  extractFigures: null,
  extractTikz: null,
  outputFiles: [],
  memories: [],
};

function stat(size: number): FileStat {
  return {
    type: FileType.File,
    ctime: 0,
    mtime: 0,
    size,
  };
}

describe('DelegationTools', () => {
  const originalStat = WorkspaceFS.stat;

  afterEach(() => {
    WorkspaceFS.stat = originalStat;
  });

  it('rejects context .bib files larger than 100KB', async () => {
    WorkspaceFS.stat = async () => stat(100 * 1024 + 1);

    const result = await rejectOversizedBibAttachments({
      ...BASE_INPUT,
      contextFile: 'references.bib',
    });

    assert.strictEqual(result?.isError, true);
    assert.strictEqual(result?.summary, 'Rejected oversized BibTeX attachment');
    assert.strictEqual(
      result?.error,
      'references.bib is 102401 bytes (100.0 KB), over the 102400 byte (100.0 KB) limit. Call extract_bib_entries first if citations are needed, then re-propose without the full .bib file.',
    );
    assert.strictEqual(result?.output, result?.error);
    assert.deepStrictEqual(result?.diagnostics, {
      type: 'oversized_bib_attachment',
      path: 'references.bib',
      sizeBytes: 102401,
      limitBytes: 102400,
    });
  });

  it('rejects context .bib files in the multi-list larger than 100KB', async () => {
    WorkspaceFS.stat = async () => stat(150 * 1024);

    const result = await rejectOversizedBibAttachments({
      ...BASE_INPUT,
      contextFiles: ['paper.tex', 'bibliography/main.bib'],
    });

    assert.strictEqual(result?.isError, true);
    assert.deepStrictEqual(result?.diagnostics, {
      type: 'oversized_bib_attachment',
      path: 'bibliography/main.bib',
      sizeBytes: 153600,
      limitBytes: 102400,
    });
  });

  it('allows .bib files at the 100KB limit', async () => {
    WorkspaceFS.stat = async () => stat(100 * 1024);

    const result = await rejectOversizedBibAttachments({
      ...BASE_INPUT,
      contextFiles: ['library.bib'],
    });

    assert.strictEqual(result, null);
  });

  it('ignores non-bib context files', async () => {
    let statCalled = false;
    WorkspaceFS.stat = async () => {
      statCalled = true;
      return stat(500 * 1024);
    };

    const result = await rejectOversizedBibAttachments({
      ...BASE_INPUT,
      contextFiles: ['paper.tex', 'preamble.tex'],
    });

    assert.strictEqual(result, null);
    assert.strictEqual(statCalled, false);
  });
});
