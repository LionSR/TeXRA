import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LaTeXdiffService } from '@latex/latexdiff';
import {
  runLatexdiffFromMetadata,
  runLatexdiffViaWorkspaceScan,
} from '@latex/latexdiff/diffOperations';
import type { LatexdiffRuntime } from '@latex/latexdiff/types';
import * as logger from '@logger/logUtils';
import type { OutputFileInfo } from '@shared/schemas';
import { installPlatform } from '@test/support/setupPlatform';
import { createWorkspaceLocation } from '@utils/files/fileLocation';

// #10635: diffOperations resolves its logger per function from the latexdiff
// runtime channel — a logger-namespace spy must observe that channel.
const CHANNEL = 'pinnedDiffChannel';

const progress = { report: () => undefined };

function runtimeWith(service: Partial<LaTeXdiffService>): LatexdiffRuntime {
  return { channel: CHANNEL, service: service as LaTeXdiffService };
}

describe('diffOperations logger seam', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs each executed diff on the latexdiff runtime channel', async () => {
    await installPlatform({
      workspacePath: '/workspace',
      files: {
        '/workspace/paper.tex': '\\documentclass{article}\n',
        '/workspace/r1/paper.tex': '\\documentclass{article}\n',
      },
    });
    const runDiffForRound = vi.fn(async () => ({
      success: true,
      message: 'diff written',
    }));
    const base = createWorkspaceLocation('/workspace/paper.tex', 'paper.tex');
    const revised = createWorkspaceLocation(
      '/workspace/r1/paper.tex',
      'r1/paper.tex',
    );
    const output: OutputFileInfo = {
      source: 'paper.tex',
      location: revised,
      round: 1,
      lineage: { original: base, diffBase: null, diffFile: null },
      diff: null,
    };
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});

    const outcome = await runLatexdiffFromMetadata({
      rounds: { 1: [output] },
      generateBetweenRoundDiffs: false,
      latexdiff: runtimeWith({ runDiffForRound }),
      progress,
    });

    expect(outcome.results).toEqual([
      expect.objectContaining({ success: true, description: 'paper.tex (r1)' }),
    ]);
    expect(runDiffForRound).toHaveBeenCalledOnce();
    expect(debug).toHaveBeenCalledWith(
      CHANNEL,
      expect.stringContaining('Running round diff: paper.tex (r1)'),
    );
  });

  it('logs workspace-scan progress on the latexdiff runtime channel', async () => {
    await installPlatform({
      workspacePath: '/workspace',
      files: { '/workspace/paper.tex': '\\documentclass{article}\n' },
    });
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});

    const outcome = await runLatexdiffViaWorkspaceScan({
      agent: 'revise',
      model: 'claude-opus-4-8',
      inputFile: 'paper.tex',
      generateBetweenRoundDiffs: false,
      latexdiff: runtimeWith({}),
      progress,
    });

    // A bare source name matches no legacy/mid-era round layout, so the scan
    // reports the empty outcome instead of dispatching diff operations.
    expect(outcome).toEqual({ results: [] });
    expect(debug).toHaveBeenCalledWith(
      CHANNEL,
      expect.stringContaining('Input files: paper.tex'),
    );
    expect(debug).toHaveBeenCalledWith(
      CHANNEL,
      expect.stringContaining('No matching outputs found for paper.tex'),
    );
  });
});
