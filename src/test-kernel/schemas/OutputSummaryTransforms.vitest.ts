import { describe, expect, it } from 'vitest';

import {
  CompileFailureSummaryFromFailureSchema,
  OutputFileSummaryFromInfoSchema,
  roundOutputsToCompileFailureSummaries,
  roundOutputsToOutputSummaries,
  type CompileFailure,
  type FileLocation,
  type OutputFileInfo,
  type RoundOutput,
} from '@shared/schemas';

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

function compileFailure(
  overrides: Partial<CompileFailure> = {},
): CompileFailure {
  return {
    round: 1,
    displayName: 'main.tex',
    output: workspace('out/main.pdf'),
    log: workspace('logs/main.log'),
    logRelativePath: 'logs/main.log',
    ...overrides,
  };
}

function roundOutput(overrides: Partial<RoundOutput> = {}): RoundOutput {
  return {
    round: 2,
    rawOutput: null,
    outputs: [],
    compileFailures: [],
    ...overrides,
  };
}

describe('output summary transforms', () => {
  it('projects rich output metadata to the flattened summary shape', () => {
    const summary = OutputFileSummaryFromInfoSchema.parse(
      outputFile({
        lineage: {
          original: workspace('src/main.tex', '/workspace/src/main.tex'),
          diffBase: workspace(
            'snapshots/main.tex',
            '/run/r1/original/main.tex',
          ),
          diffFile: null,
        },
        diff: { added: 7, removed: 3 },
      }),
    );

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
    const summary = OutputFileSummaryFromInfoSchema.parse(
      outputFile({
        location: external('/tmp/main.pdf'),
      }),
    );

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

  it('projects compile failures to flattened paths', () => {
    const workspaceSummary = CompileFailureSummaryFromFailureSchema.parse(
      compileFailure({
        output: workspace('build/main.pdf', '/workspace/build/main.pdf'),
      }),
    );
    const externalSummary = CompileFailureSummaryFromFailureSchema.parse(
      compileFailure({
        output: external('/tmp/main.pdf'),
      }),
    );

    expect(workspaceSummary.outputPath).toBe('build/main.pdf');
    expect(workspaceSummary.logPath).toBe('logs/main.log');
    expect(workspaceSummary.logAbsolutePath).toBe('/workspace/logs/main.log');
    expect(externalSummary.outputPath).toBe('/tmp/main.pdf');
  });

  it('projects compile failures from round outputs', () => {
    const summaries = roundOutputsToCompileFailureSummaries([
      roundOutput({
        compileFailures: [compileFailure({ round: 3 })],
      }),
    ]);

    expect(summaries).toEqual([
      {
        round: 3,
        displayName: 'main.tex',
        outputPath: 'out/main.pdf',
        logPath: 'logs/main.log',
        logAbsolutePath: '/workspace/logs/main.log',
      },
    ]);
  });
});
