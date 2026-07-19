// Node imports
import * as assert from 'node:assert';

// Third-party imports
import { describe, it, afterEach, vi } from 'vitest';

const gitignoreMock = vi.hoisted(() => ({
  ignoredPaths: new Set<string>(),
}));

vi.mock('@tools/gitignore', () => ({
  getGitignoreMatcher: async () => ({
    ignores: (path: string) => gitignoreMock.ignoredPaths.has(path),
  }),
}));

// Local imports
import * as arxivModule from '@latex/arxivProcessor';
import { FileType } from '@platform/interfaces';
import { ArxivDownloadTool } from '@tools/arxiv/ArxivDownloadTool';
import { WorkspaceFS } from '@utils/files';

declare module '@latex/arxivProcessor' {
  interface ArxivSourceProcessor {
    validateId(id: string): string | null;
    downloadSource(
      input: string,
      options?: DownloadSourceOptions,
    ): Promise<{ path: string; alreadyExisted: boolean }>;
  }
}

// Mutable references for stubbing
const processor = arxivModule.ArxivProcessor as {
  validateId: typeof arxivModule.ArxivProcessor.validateId;
  downloadSource: typeof arxivModule.ArxivProcessor.downloadSource;
};
const wsFS = WorkspaceFS as unknown as {
  relativePath: typeof WorkspaceFS.relativePath;
  readDir: typeof WorkspaceFS.readDir;
};

describe('ArxivDownloadTool', () => {
  const originalValidateId = processor.validateId;
  const originalDownloadSource = processor.downloadSource;
  const originalRelativePath = wsFS.relativePath;
  const originalReadDir = wsFS.readDir;

  afterEach(() => {
    processor.validateId = originalValidateId;
    processor.downloadSource = originalDownloadSource;
    wsFS.relativePath = originalRelativePath;
    wsFS.readDir = originalReadDir;
    gitignoreMock.ignoredPaths.clear();
  });

  it('returns download summary and a listing of the extracted files', async () => {
    let receivedId: string | undefined;
    let receivedAutoIndent: boolean | undefined;
    let validateCalls = 0;

    processor.validateId = () => {
      validateCalls += 1;
      return null;
    };

    processor.downloadSource = async (id, options) => {
      receivedId = id;
      receivedAutoIndent = options?.autoIndent;
      return { path: '/workspace/project/sample', alreadyExisted: false };
    };

    wsFS.relativePath = () => 'sample';

    gitignoreMock.ignoredPaths.add('sample/node_modules');

    wsFS.readDir = async () => [
      ['.git', FileType.Directory],
      ['.gitignore', FileType.File],
      ['main.tex', FileType.File],
      ['node_modules', FileType.Directory],
      ['src', FileType.Directory],
    ];

    const tool = new ArxivDownloadTool();
    const result = await tool.call({ id: '2401.12345v2', autoIndent: false });

    assert.strictEqual(validateCalls, 1);
    assert.strictEqual(receivedId, '2401.12345v2');
    assert.strictEqual(receivedAutoIndent, false);
    assert.strictEqual(result.summary, 'arXiv source downloaded to sample');
    assert.ok(result.output?.includes('Directory listing for sample'));
    assert.ok(result.output?.includes('file main.tex'));
    assert.ok(!result.output?.includes('.gitignore'));
    assert.ok(!result.output?.includes('node_modules'));
  });
});
