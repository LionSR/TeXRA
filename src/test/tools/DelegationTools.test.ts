// Node.js built-in imports
import * as assert from 'assert';

// Platform imports
import { FileType, type FileStat } from '@platform/interfaces/filesystem';

// Local imports - tools
import {
  rejectOversizedLibraryBibAuxiliary,
  type WorkflowAgentInput,
} from '@tools/DelegationTools';
import { WorkspaceFS } from '@utils/files';

const BASE_INPUT: WorkflowAgentInput = {
  agent: 'criticize',
  model: 'opus47T',
  instruction: 'Review the manuscript.',
  inputFile: 'main.tex',
  inputFiles: [],
  referenceFile: null,
  referenceFiles: [],
  auxiliaryFile: null,
  auxiliaryFiles: [],
  mediaFile: null,
  mediaFiles: [],
  extractFigures: null,
  extractTikz: null,
  outputFiles: [],
  useMultipleOutputs: false,
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

  it('rejects auxiliary library.bib files larger than 100KB', async () => {
    WorkspaceFS.stat = async () => stat(100 * 1024 + 1);

    const result = await rejectOversizedLibraryBibAuxiliary({
      ...BASE_INPUT,
      auxiliaryFile: 'library.bib',
    });

    assert.strictEqual(result?.isError, true);
    assert.strictEqual(result?.summary, 'Rejected oversized library.bib');
    assert.strictEqual(
      result?.error,
      'library.bib is 102401 bytes (100.0 KB), over the 102400 byte (100.0 KB) limit. Call extract_bib_entries first if citations are needed, then re-propose without library.bib.',
    );
    assert.strictEqual(result?.output, result?.error);
    assert.deepStrictEqual(result?.diagnostics, {
      type: 'oversized_library_bib',
      path: 'library.bib',
      sizeBytes: 102401,
      limitBytes: 102400,
    });
  });

  it('allows auxiliary library.bib files at the 100KB limit', async () => {
    WorkspaceFS.stat = async () => stat(100 * 1024);

    const result = await rejectOversizedLibraryBibAuxiliary({
      ...BASE_INPUT,
      auxiliaryFiles: ['library.bib'],
    });

    assert.strictEqual(result, null);
  });

  it('ignores non-library auxiliary files', async () => {
    let statCalled = false;
    WorkspaceFS.stat = async () => {
      statCalled = true;
      return stat(500 * 1024);
    };

    const result = await rejectOversizedLibraryBibAuxiliary({
      ...BASE_INPUT,
      auxiliaryFiles: ['references.bib'],
    });

    assert.strictEqual(result, null);
    assert.strictEqual(statCalled, false);
  });
});
