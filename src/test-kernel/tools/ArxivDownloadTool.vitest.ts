// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

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
import { WorkspaceFS } from '@utils/files/workspaceFS';

declare module '@latex/arxivProcessor' {
  interface ArxivSourceProcessor {
    validateId(id: string): string | null;
    downloadSource(
      input: string,
      options?: DownloadSourceOptions,
    ): Promise<{ path: string; alreadyExisted: boolean }>;
  }
}

describe('ArxivDownloadTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    gitignoreMock.ignoredPaths.clear();
  });

  it('returns download summary and a listing of the extracted files', async () => {
    const validateId = vi
      .spyOn(arxivModule.ArxivProcessor, 'validateId')
      .mockReturnValue(null);
    const downloadSource = vi
      .spyOn(arxivModule.ArxivProcessor, 'downloadSource')
      .mockResolvedValue({
        path: '/workspace/project/sample',
        alreadyExisted: false,
      });

    vi.spyOn(WorkspaceFS, 'relativePath').mockReturnValue('sample');

    gitignoreMock.ignoredPaths.add('sample/node_modules');

    vi.spyOn(WorkspaceFS, 'readDir').mockResolvedValue([
      ['.git', FileType.Directory],
      ['.gitignore', FileType.File],
      ['main.tex', FileType.File],
      ['node_modules', FileType.Directory],
      ['src', FileType.Directory],
    ]);

    const tool = new ArxivDownloadTool();
    const result = await tool.call({ id: '2401.12345v2', autoIndent: false });

    expect(validateId).toHaveBeenCalledWith('2401.12345v2');
    expect(downloadSource).toHaveBeenCalledWith(
      '2401.12345v2',
      expect.objectContaining({ autoIndent: false }),
    );
    expect(result.summary).toBe('arXiv source downloaded to sample');
    expect(result.output).toContain('Directory listing for sample');
    expect(result.output).toContain('file main.tex');
    expect(result.output).not.toContain('.gitignore');
    expect(result.output).not.toContain('node_modules');
  });
});
