// Node imports
import path from 'node:path';

// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { computeOutputDiffStats } from '@agent/implementations/flows/reflection/output/diffComputation';
import { assignByContentSimilarity } from '@agent/implementations/flows/reflection/output/extraction/contentSimilarity';
import {
  createOutputState,
  ensureRoundData,
} from '@agent/implementations/flows/reflection/output/outputState';
import type { RoundFileMapping } from '@agent/implementations/flows/reflection/output/types';
import { fileLocationDisplayPath, type ExecutionId } from '@shared/schemas';
import { installPlatform } from '@test/support/setupPlatform';
import { computeAndWriteWorkflowDiffs } from '@tools/delegation/subagentResults';
import {
  computeLineChangeSummary,
  firstChangedLine,
  writeApprovedContent,
} from '@tools/approval/toolEditApproval';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { createExternalLocation } from '@utils/files/fileLocation';
import { getRunDir } from '@utils/files/runStorageFs';
import { unifiedDiffText } from '@utils/text/unifiedDiff';

function installFakePlatform(
  files: Record<string, string> = {},
): Promise<void> {
  return installPlatform({
    files,
    storagePath: '/workspace/.texra/storage',
    workspacePath: '/workspace',
  });
}

describe('shared text-diff caller fixtures', () => {
  it('preserves output diff line-change stats', async () => {
    await installFakePlatform({
      '/workspace/base.tex': 'one\ntwo\nthree\n',
      '/workspace/out.tex': 'one\nTWO\nthree\nfour\n',
    });
    const state = createOutputState();
    const outputLocation = createExternalLocation('/workspace/out.tex');
    ensureRoundData(state, 0).outputs = [
      {
        source: 'out.tex',
        round: 0,
        location: outputLocation,
        lineage: null,
        diff: null,
      },
    ];
    const baseLocation = createExternalLocation('/workspace/base.tex');
    const mapping: RoundFileMapping = new Map([
      [fileLocationDisplayPath(outputLocation), { base: baseLocation }],
    ]);

    const [output] = await computeOutputDiffStats(
      state,
      [baseLocation],
      0,
      mapping,
    );

    expect(output?.diff).toEqual({ added: 2, removed: 1 });
  });

  it('preserves content-similarity assignment output', () => {
    const revision = 'Intro\nrevised result\nConclusion\n';
    const unrelated = 'Detached notes about something else entirely.';

    const assigned = assignByContentSimilarity(
      [revision, unrelated],
      [
        {
          name: 'paper.tex',
          content: 'Intro\noriginal result\nConclusion\n',
        },
      ],
      0.5,
    );

    expect(assigned).toEqual([{ content: revision, name: 'paper.tex' }, null]);
  });

  it('preserves subagent line-mode diff files', async () => {
    await installFakePlatform({
      '/workspace/original.tex': 'one\ntwo\nthree\n',
      '/workspace/out/section/paper.tex': 'one\nTWO\nthree\nfour\n',
    });
    const executionId = 'abcdef' as ExecutionId;

    const result = await computeAndWriteWorkflowDiffs(executionId, [
      {
        round: 0,
        relativePath: 'section/paper.tex',
        absolutePath: '/workspace/out/section/paper.tex',
        location: 'workspace',
        originalPath: '/workspace/original.tex',
        added: 2,
        removed: 1,
      },
    ]);

    expect(result.get('/workspace/out/section/paper.tex')).toEqual({
      diffRelPath: 'diffs/section_paper.tex.diff',
      largeChange: true,
    });
    await expect(
      AbsoluteFS.read(
        path.join(getRunDir(executionId), 'diffs/section_paper.tex.diff'),
      ),
    ).resolves.toBe('@@ -1,3 +1,4 @@\n one\n-two\n+TWO\n three\n+four');
  });

  it('preserves tool-edit approval diff summaries and patch application', async () => {
    const original = 'alpha\nbeta\nomega\n';
    const final = 'alpha\nBETA\nomega\n';

    expect(computeLineChangeSummary(original, final)).toEqual({
      added: 1,
      removed: 1,
    });
    expect(
      firstChangedLine('alpha\nbeta\nomega\n', 'alpha\ninsert\nbeta\nomega\n'),
    ).toBe(1);
    const patch = unifiedDiffText(original, final);
    expect(patch).toContain('-beta');
    expect(patch).toContain('+BETA');

    await installFakePlatform({
      '/workspace/paper.tex': 'alpha\nbeta\nomega\nlocal\n',
    });
    const writeResult = await writeApprovedContent(
      'paper.tex',
      original,
      final,
    );

    expect(writeResult).toEqual({
      appliedContent: 'alpha\nBETA\nomega\nlocal\n',
      baseContent: 'alpha\nbeta\nomega\nlocal\n',
    });
    await expect(AbsoluteFS.read('/workspace/paper.tex')).resolves.toBe(
      'alpha\nBETA\nomega\nlocal\n',
    );
  });
});
