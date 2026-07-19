// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports - tests

// Local imports - runtime
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';

// Local imports - tools
import { setupPlatform } from '@test/support/setupPlatform';
import {
  OpenPdfTool,
  setOpenPdfOpener,
  type OpenPdfRequest,
} from '@tools/OpenPdfTool';

describe('OpenPdfTool', () => {
  setupPlatform({
    workspacePath: '/workspace',
    storagePath: '/storage',
    files: {
      '/workspace/paper.pdf': '%PDF-1.4\n',
      '/workspace/figures/result.pdf': '%PDF-1.4\n',
      '/run/paper.pdf': '%PDF-1.4\n',
      '/storage/executions/run-1/output.pdf': '%PDF-1.4\n',
      '/workspace/paper.tex': '\\documentclass{article}',
    },
  });

  beforeEach(() => {
    setOpenPdfOpener(undefined);
  });

  it('reports that PDF opening is unavailable when no host callback is registered', async () => {
    const tool = new OpenPdfTool();

    const result = await tool.call({ path: 'paper.tex' });

    expect(result).toMatchObject({
      status: 'error',
      error: expect.stringContaining('open_pdf is not available'),
    });
  });

  it('opens an existing PDF through the registered host callback', async () => {
    const openPdf = vi.fn<(request: OpenPdfRequest) => Promise<void>>();
    openPdf.mockResolvedValue(undefined);
    setOpenPdfOpener(openPdf);
    const tool = new OpenPdfTool();

    const result = await tool.call({
      path: 'figures/result.pdf',
      preserve_focus: true,
    });

    expect(result).toMatchObject({
      summary: 'Opened PDF: figures/result.pdf',
      output: 'Opened PDF: figures/result.pdf',
    });
    expect(openPdf).toHaveBeenCalledWith({
      location: {
        kind: 'workspace',
        absolutePath: '/workspace/figures/result.pdf',
        relativePath: 'figures/result.pdf',
      },
      preserveFocus: true,
    });
  });

  it('allows absolute paths inside active run storage', async () => {
    const openPdf = vi.fn<(request: OpenPdfRequest) => Promise<void>>();
    openPdf.mockResolvedValue(undefined);
    setOpenPdfOpener(openPdf);
    const tool = new OpenPdfTool();

    const result = await withRunContext(
      createRunContext({
        runtimeHost: createRuntimeHost(),
        executionId: 'run-1',
      }),
      () =>
        tool.call({
          path: '/storage/executions/run-1/output.pdf',
          preserve_focus: true,
        }),
    );

    expect(result).toMatchObject({
      summary: 'Opened PDF: output.pdf',
      output: 'Opened PDF: output.pdf',
    });
    expect(openPdf).toHaveBeenCalledWith({
      location: {
        kind: 'runStorage',
        absolutePath: '/storage/executions/run-1/output.pdf',
        relativePath: 'output.pdf',
        executionId: 'run-1',
      },
      preserveFocus: true,
    });
  });

  it('does not parse working_directory before checking absolute run-storage paths', async () => {
    const openPdf = vi.fn<(request: OpenPdfRequest) => Promise<void>>();
    openPdf.mockResolvedValue(undefined);
    setOpenPdfOpener(openPdf);
    const tool = new OpenPdfTool();

    const result = await withRunContext(
      createRunContext({
        runtimeHost: createRuntimeHost(),
        executionId: 'run-1',
        workingDirectory: 'relative-path',
      }),
      () => tool.call({ path: '/storage/executions/run-1/output.pdf' }),
    );

    expect(result).toMatchObject({
      summary: 'Opened PDF: output.pdf',
      output: 'Opened PDF: output.pdf',
    });
    expect(openPdf).toHaveBeenCalledOnce();
  });

  it('rejects arbitrary absolute paths outside the allowed roots', async () => {
    const openPdf = vi.fn<(request: OpenPdfRequest) => Promise<void>>();
    setOpenPdfOpener(openPdf);
    const tool = new OpenPdfTool();

    const result = await withRunContext(
      createRunContext({
        runtimeHost: createRuntimeHost(),
        workingDirectory: '/workspace',
      }),
      () => tool.call({ path: '/run/paper.pdf' }),
    );

    expect(result).toMatchObject({
      status: 'error',
      error: expect.stringContaining(
        'Path must stay within the working directory',
      ),
    });
    expect(openPdf).not.toHaveBeenCalled();
  });

  it('rejects non-PDF files before invoking the host callback', async () => {
    const openPdf = vi.fn<(request: OpenPdfRequest) => Promise<void>>();
    setOpenPdfOpener(openPdf);
    const tool = new OpenPdfTool();

    const result = await tool.call({ path: 'paper.tex' });

    expect(result).toMatchObject({
      status: 'error',
      error: expect.stringContaining('open_pdf only opens PDF files'),
    });
    expect(openPdf).not.toHaveBeenCalled();
  });
});

function createRuntimeHost(): AgentRuntimeHost {
  return { emit: vi.fn() };
}
