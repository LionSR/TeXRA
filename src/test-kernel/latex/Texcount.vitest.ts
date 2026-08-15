import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LATEX_COMMANDS_CHANNEL } from '@latex/latexLogging';
import { getTeXCount } from '@latex/texcount';
import * as logger from '@logger/logUtils';
import { platform } from '@platform/platform';
import { installPlatform } from '@test/support/setupPlatform';

const mocks = vi.hoisted(() => ({
  runToolWithCheck: vi.fn(),
}));

vi.mock('@utils/system/toolUtils', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@utils/system/toolUtils')>();
  return { ...actual, runToolWithCheck: mocks.runToolWithCheck };
});

// #10635: texcount's helpers resolve their logger per function from the
// threaded channel — a logger-namespace spy must observe the resolved channel.
describe('texcount logger seam', () => {
  beforeEach(() => {
    mocks.runToolWithCheck.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('warns on the resolved channel when no files are provided', async () => {
    await installPlatform({ workspacePath: '/workspace' });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const pinned = await getTeXCount('   ', { channel: 'pinnedTexcount' });
    const defaulted = await getTeXCount('');

    expect(pinned).toEqual({
      output: null,
      errors: ['No LaTeX files provided for texcount.'],
    });
    expect(defaulted).toEqual(pinned);
    expect(warn).toHaveBeenCalledWith(
      'pinnedTexcount',
      'No LaTeX files provided for texcount.',
    );
    expect(warn).toHaveBeenCalledWith(
      LATEX_COMMANDS_CHANNEL,
      'No LaTeX files provided for texcount.',
    );
  });

  it('warns on the resolved channel when a file does not exist', async () => {
    await installPlatform({ workspacePath: '/workspace' });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const result = await getTeXCount('missing.tex', {
      channel: 'pinnedTexcount',
    });

    expect(result.output).toBeNull();
    expect(result.errors).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      'pinnedTexcount',
      expect.stringContaining('does not exist'),
    );
  });

  // The module-level `const log = createLog(CHANNEL)` in texcount.ts is bound
  // at import time, before this suite's spy exists — exactly the case
  // createLog's per-call loggerSelf lookup exists for. A read failure inside
  // hasChinesePackages must still reach the spied namespace.
  it('emits through the import-time module binding when the Chinese-package check fails', async () => {
    await installPlatform({
      workspacePath: '/workspace',
      files: { '/workspace/main.tex': '\\documentclass{article}\n' },
    });
    // The first (and only) AbsoluteFS.read in this flow is hasChinesePackages'.
    vi.spyOn(platform().fs, 'readFile').mockRejectedValueOnce(
      new Error('disk flutter'),
    );
    mocks.runToolWithCheck.mockResolvedValue({
      success: true,
      stdout: 'Words in text: 5',
      stderr: '',
      exitCode: 0,
    });
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {});

    const result = await getTeXCount('main.tex');

    // The failed Chinese-package probe is best-effort: the count still runs.
    expect(result.output).toContain('Words in text: 5');
    expect(error).toHaveBeenCalledWith(
      LATEX_COMMANDS_CHANNEL,
      expect.stringContaining('Error checking Chinese packages: disk flutter'),
    );
  });

  it('logs a failing texcount invocation at error level on the resolved channel', async () => {
    await installPlatform({
      workspacePath: '/workspace',
      files: { '/workspace/main.tex': '\\documentclass{article}\n' },
    });
    mocks.runToolWithCheck.mockResolvedValue({
      success: false,
      stdout: 'partial output',
      stderr: 'texcount exploded',
      exitCode: 1,
    });
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {});

    const result = await getTeXCount('main.tex', { channel: 'pinnedTexcount' });

    expect(result.output).toBeNull();
    expect(result.errors.join('\n')).toContain('texcount exploded');
    expect(error).toHaveBeenCalledWith(
      'pinnedTexcount',
      expect.stringContaining('Error getting tex count for'),
    );
    expect(error).toHaveBeenCalledWith(
      'pinnedTexcount',
      expect.stringContaining('Stderr: texcount exploded'),
    );
  });

  // #10649: getSummedCount also resolves its logger per call from the
  // threaded channel. Its one emission of its own is the Chinese-package
  // debug line, so a Chinese-package file in sum mode must reach the spied
  // namespace on both the threaded and the default channel.
  it('emits the sum-mode Chinese-package debug line on the resolved channel', async () => {
    await installPlatform({
      workspacePath: '/workspace',
      files: { '/workspace/main.tex': '\\documentclass{ctexart}\n' },
    });
    mocks.runToolWithCheck.mockResolvedValue({
      success: true,
      stdout: 'Words in text: 5',
      stderr: '',
      exitCode: 0,
    });
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});

    const pinned = await getTeXCount('main.tex', {
      mode: 'sum',
      channel: 'pinnedTexcount',
    });
    const defaulted = await getTeXCount('main.tex', { mode: 'sum' });

    // The (sum) prefix proves the summed path, not the per-file path, ran.
    expect(pinned.output).toContain('Combined TeX Count Results (sum):');
    expect(defaulted).toEqual(pinned);
    expect(debug).toHaveBeenCalledWith(
      'pinnedTexcount',
      'Chinese packages detected in main.tex, enabling Chinese character counting',
    );
    expect(debug).toHaveBeenCalledWith(
      LATEX_COMMANDS_CHANNEL,
      'Chinese packages detected in main.tex, enabling Chinese character counting',
    );
  });
});
