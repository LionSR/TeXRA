// Node imports
import * as path from 'node:path';

// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

// Local imports
import type { OpenPdfRequest } from '@agent/runtime/HostInteractions';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { defaultSession } from '@agent/runtime/SessionHandle';
import { setupPlatform } from '@test/support/setupPlatform';
import { OpenPdfTool } from '@tools/OpenPdfTool';

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

  let detachHostInteractions = (): void => {};

  afterEach(() => {
    detachHostInteractions();
    detachHostInteractions = () => undefined;
  });

  /** Attach a PDF viewer the way a host does: as a session capability. */
  function installOpener(): Mock<(request: OpenPdfRequest) => Promise<void>> {
    const openPdf = vi.fn<(request: OpenPdfRequest) => Promise<void>>();
    openPdf.mockResolvedValue(undefined);
    detachHostInteractions();
    detachHostInteractions = defaultSession().useHostInteractions({
      openPdf,
      cancel: () => undefined,
    });
    return openPdf;
  }

  function expectOpenError(result: unknown, fragment: string): void {
    expect(result).toMatchObject({
      status: 'error',
      error: expect.stringContaining(fragment),
    });
  }

  function expectOpened(result: unknown, label: string): void {
    expect(result).toMatchObject({
      summary: `Opened PDF: ${label}`,
      output: `Opened PDF: ${label}`,
    });
  }

  it('reports that PDF opening is unavailable when no host serves it', async () => {
    const tool = new OpenPdfTool();

    const result = await tool.call({ path: 'paper.tex' });

    expectOpenError(result, 'open_pdf is not available');
  });

  it('opens an existing PDF through the registered host callback', async () => {
    const openPdf = installOpener();
    const tool = new OpenPdfTool();

    const result = await tool.call({
      path: 'figures/result.pdf',
      preserve_focus: true,
    });

    expectOpened(result, 'figures/result.pdf');
    expect(openPdf).toHaveBeenCalledWith({
      location: {
        kind: 'workspace',
        absolutePath: path.join(path.sep, 'workspace', 'figures', 'result.pdf'),
        relativePath: 'figures/result.pdf',
      },
      preserveFocus: true,
    });
  });

  it('allows absolute paths inside active run storage', async () => {
    const openPdf = installOpener();
    const tool = new OpenPdfTool();

    const result = await withRunContext(
      createRunContext({
        executionId: 'run-1',
      }),
      () =>
        tool.call({
          path: '/storage/executions/run-1/output.pdf',
          preserve_focus: true,
        }),
    );

    expectOpened(result, 'output.pdf');
    expect(openPdf).toHaveBeenCalledWith({
      location: {
        kind: 'runStorage',
        absolutePath: path.join(
          path.sep,
          'storage',
          'executions',
          'run-1',
          'output.pdf',
        ),
        relativePath: 'output.pdf',
        executionId: 'run-1',
      },
      preserveFocus: true,
    });
  });

  it('does not parse working_directory before checking absolute run-storage paths', async () => {
    const openPdf = installOpener();
    const tool = new OpenPdfTool();

    const result = await withRunContext(
      createRunContext({
        executionId: 'run-1',
        workingDirectory: 'relative-path',
      }),
      () => tool.call({ path: '/storage/executions/run-1/output.pdf' }),
    );

    expectOpened(result, 'output.pdf');
    expect(openPdf).toHaveBeenCalledOnce();
  });

  it('rejects arbitrary absolute paths outside the allowed roots', async () => {
    const openPdf = installOpener();
    const tool = new OpenPdfTool();

    const result = await withRunContext(
      createRunContext({
        workingDirectory: '/workspace',
      }),
      () => tool.call({ path: '/run/paper.pdf' }),
    );

    expectOpenError(result, 'Path must stay within the working directory');
    expect(openPdf).not.toHaveBeenCalled();
  });

  it('rejects non-PDF files before invoking the host callback', async () => {
    const openPdf = installOpener();
    const tool = new OpenPdfTool();

    const result = await tool.call({ path: 'paper.tex' });

    expectOpenError(result, 'open_pdf only opens PDF files');
    expect(openPdf).not.toHaveBeenCalled();
  });
});
