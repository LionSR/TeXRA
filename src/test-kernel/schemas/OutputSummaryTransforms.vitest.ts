import { describe, expect, it } from 'vitest';

import { type FileLocation } from '@shared/schemas';
import {
  latexdiffDisplayName,
  roundOutputsToOutputSummaries,
  type RoundOutput,
  type OutputFileInfo,
} from '@texra/shared/plugins/documentOutputs';

function workspace(
  relativePath: string,
  absolutePath = `/workspace/${relativePath}`,
): FileLocation {
  return {
    kind: 'workspace',
    absolutePath,
    relativePath,
  };
}

function external(absolutePath: string): FileLocation {
  return {
    kind: 'external',
    absolutePath,
  };
}

function outputFile(overrides: Partial<OutputFileInfo> = {}): OutputFileInfo {
  return {
    source: 'document',
    location: workspace('out/main.pdf'),
    round: 1,
    lineage: null,
    diff: null,
    ...overrides,
  };
}

function roundOutput(overrides: Partial<RoundOutput> = {}): RoundOutput {
  return {
    round: 2,
    outputs: [],
    compileFailures: [],
    missingOutputs: [],
    latexdiffs: [],
    reply: null,
    ...overrides,
  };
}

describe('output summary transforms', () => {
  it('projects rich output metadata to the flattened summary shape', () => {
    const [summary] = roundOutputsToOutputSummaries([
      roundOutput({
        round: 1,
        outputs: [
          outputFile({
            lineage: {
              original: workspace('src/main.tex', '/workspace/src/main.tex'),
              diffBase: workspace(
                'snapshots/main.tex',
                '/run/r1/original/main.tex',
              ),
            },
            diff: { added: 7, removed: 3 },
          }),
        ],
      }),
    ]);

    expect(summary).toEqual({
      round: 1,
      relativePath: 'out/main.pdf',
      absolutePath: '/workspace/out/main.pdf',
      location: 'workspace',
      originalPath: '/run/r1/original/main.tex',
      added: 7,
      removed: 3,
    });
  });

  it('falls back to the absolute path for external output locations', () => {
    const [summary] = roundOutputsToOutputSummaries([
      roundOutput({
        outputs: [outputFile({ location: external('/tmp/main.pdf') })],
      }),
    ]);

    expect(summary.relativePath).toBe('/tmp/main.pdf');
    expect(summary.absolutePath).toBe('/tmp/main.pdf');
    expect(summary.location).toBe('external');
  });

  it('uses the round output round for persisted output summaries', () => {
    const summaries = roundOutputsToOutputSummaries([
      roundOutput({
        round: 4,
        outputs: [outputFile({ round: 99 })],
      }),
    ]);

    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.round).toBe(4);
  });

  it('names a latexdiff by its workspace document, else by its base', () => {
    const entry = {
      revised: external('/tmp/run/r2/main.tex'),
      original: workspace('src/main.tex'),
      base: workspace('main.tex'),
      baseRound: 1,
      status: 'ok',
      diff: external('/tmp/run/diff/r2/main_diff.tex'),
    } as const;
    expect(latexdiffDisplayName(entry)).toBe('main.tex');
    expect(latexdiffDisplayName({ ...entry, original: null })).toBe('main.tex');
  });
});
