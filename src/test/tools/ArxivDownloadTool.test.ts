// Node.js built-in imports
import * as assert from 'assert';

// Local imports - tools
import * as arxivModule from '@latex/arxivProcessor';
import { LsTool } from '@tools/ls';
import type { ToolResult } from '@tools/result';
import { WorkspaceFS } from '@utils/files';
import { ArxivDownloadTool } from '@/tools/arxiv/ArxivDownloadTool';

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
const processor = arxivModule.arxivProcessor as {
  validateId: typeof arxivModule.arxivProcessor.validateId;
  downloadSource: typeof arxivModule.arxivProcessor.downloadSource;
};
const wsFS = WorkspaceFS as unknown as {
  relativePath: typeof WorkspaceFS.relativePath;
};
const lsProto = LsTool.prototype as unknown as {
  call: typeof LsTool.prototype.call;
};

describe('ArxivDownloadTool', () => {
  const originalValidateId = processor.validateId;
  const originalDownloadSource = processor.downloadSource;
  const originalRelativePath = wsFS.relativePath;
  const originalLsCall = lsProto.call;

  afterEach(() => {
    processor.validateId = originalValidateId;
    processor.downloadSource = originalDownloadSource;
    wsFS.relativePath = originalRelativePath;
    lsProto.call = originalLsCall;
  });

  it('returns download summary and listing from ls tool', async () => {
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

    lsProto.call = async (): Promise<ToolResult> => ({
      summary: 'Listing for sample',
      output: 'dir src\nfile main.tex',
    });

    const tool = new ArxivDownloadTool();
    const result = await tool.call({ id: '2401.12345v2', autoIndent: false });

    assert.strictEqual(validateCalls, 1);
    assert.strictEqual(receivedId, '2401.12345v2');
    assert.strictEqual(receivedAutoIndent, false);
    assert.strictEqual(result.summary, 'arXiv source downloaded to sample');
    assert.ok(result.output?.includes('Listing for sample'));
    assert.ok(result.output?.includes('file main.tex'));
  });
});
