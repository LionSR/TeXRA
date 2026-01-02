// Node.js built-in imports
import * as assert from 'assert';

// Local imports - tools
import { LsTool } from '@tools/ls';
import type { ToolResult } from '@tools/result';
import { WorkspaceFS } from '@utils/files';
import * as arxivModule from '@latex/arxivProcessor';
import { ArxivDownloadTool } from '@/tools/arxiv/ArxivDownloadTool';

declare module '@latex/arxivProcessor' {
  interface ArxivSourceProcessor {
    validateId(id: string): string | null;
    downloadSource(
      id: string,
      progress?: (msg: string, increment?: number) => void,
      autoIndent?: boolean,
    ): Promise<string>;
  }
}

describe('ArxivDownloadTool', () => {
  const originalValidateId = arxivModule.arxivProcessor.validateId;
  const originalDownloadSource = arxivModule.arxivProcessor.downloadSource;
  const originalRelativePath = WorkspaceFS.relativePath;
  const originalLsCall = LsTool.prototype.call;

  afterEach(() => {
    (
      arxivModule.arxivProcessor as {
        validateId: typeof originalValidateId;
      }
    ).validateId = originalValidateId;
    (
      arxivModule.arxivProcessor as {
        downloadSource: typeof originalDownloadSource;
      }
    ).downloadSource = originalDownloadSource;
    (
      WorkspaceFS as unknown as {
        relativePath: typeof originalRelativePath;
      }
    ).relativePath = originalRelativePath;
    (
      LsTool.prototype as unknown as {
        call: typeof originalLsCall;
      }
    ).call = originalLsCall;
  });

  it('returns download summary and listing from ls tool', async () => {
    let receivedId: string | undefined;
    let receivedAutoIndent: boolean | undefined;
    let validateCalls = 0;

    (
      arxivModule.arxivProcessor as {
        validateId: typeof originalValidateId;
      }
    ).validateId = (id: string) => {
      validateCalls += 1;
      return null;
    };

    (
      arxivModule.arxivProcessor as {
        downloadSource: typeof originalDownloadSource;
      }
    ).downloadSource = async (id, _progress, autoIndent) => {
      receivedId = id;
      receivedAutoIndent = autoIndent;
      return '/workspace/project/sample';
    };

    (
      WorkspaceFS as unknown as {
        relativePath: typeof originalRelativePath;
      }
    ).relativePath = () => 'sample';

    (
      LsTool.prototype as unknown as {
        call: typeof originalLsCall;
      }
    ).call = async (): Promise<ToolResult> => ({
      summary: 'Listing for sample',
      output: 'dir src\nfile main.tex',
    });

    const tool = new ArxivDownloadTool();
    const result = await tool.call({ id: '2401.12345v2', autoIndent: false });

    assert.strictEqual(validateCalls, 1);
    assert.strictEqual(receivedId, '2401.12345v2');
    assert.strictEqual(receivedAutoIndent, false);
    assert.strictEqual(result.summary, 'Downloaded arXiv source to sample');
    assert.ok(result.output?.includes('Listing for sample'));
    assert.ok(result.output?.includes('file main.tex'));
  });
});
