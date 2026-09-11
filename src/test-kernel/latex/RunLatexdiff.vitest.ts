import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';
import type { LaTeXdiffService } from '@latex/latexdiff';
import type { LatexRunDiscoveryPort } from '@latex/latexdiff/runDiscovery';
import type { DiffRunOutcome } from '@latex/latexdiff/types';
import { normalizeRunLatexdiffOutputsByRound } from '@latex/latexdiff/runLatexdiff';
import { effectDiagnosticsLayer } from '@logger/effectDiagnostics';
import { setLogSink } from '@logger/logSink';
import type { OutputFileInfo, RoundIndexed } from '@shared/schemas';
import { captureLogEntries } from '@test/support/logSinkCapture';
import { installPlatform } from '@test/support/setupPlatform';

import { createOutputFile } from '../support/ProgressControllerHarnesses';

const mocks = vi.hoisted(() => ({
  scanRunDirForOutputs: vi.fn(),
  discoverLatestRunOutputs: vi.fn(),
  runLatexdiffFromMetadata: vi.fn(),
}));

vi.mock('@latex/latexdiff/runOutputFiles', () => ({
  scanRunDirForOutputs: mocks.scanRunDirForOutputs,
}));

vi.mock('@latex/latexdiff/outputDiscovery', () => ({
  discoverLatestRunOutputs: mocks.discoverLatestRunOutputs,
}));

vi.mock('@latex/latexdiff/diffOperations', () => ({
  runLatexdiffFromMetadata: mocks.runLatexdiffFromMetadata,
}));

const { runLatexdiffForRun } = await import('@latex/latexdiff/runLatexdiff');

const latexdiff = {
  channel: 'test',
  service: {} as LaTeXdiffService,
};

/**
 * The diff engines are mocked here, so the outcome is a placeholder: these
 * tests assert which engine ran and how the outputs were resolved, never what
 * the engine returned.
 */
const EMPTY_OUTCOME: DiffRunOutcome = { results: [] };

function roundMap(): RoundIndexed<OutputFileInfo> {
  return { 1: [] as OutputFileInfo[] };
}

const runDiscovery: LatexRunDiscoveryPort = {
  listAgentRuns: () => Effect.succeed([]),
  readRunOutputs: () => Effect.succeed({}),
};

const baseRequest = {
  filesystem: { readDirectory: vi.fn(), isSymlink: vi.fn() },
  agent: 'revise',
  model: 'claude-opus-4-8',
  inputFile: 'paper.tex',
  runDiscovery,
  generateBetweenRoundDiffs: false,
  latexdiff,
  progress: { report: () => undefined },
} as const;

describe('runLatexdiffForRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runLatexdiffFromMetadata.mockReturnValue(
      Effect.succeed(EMPTY_OUTCOME),
    );
  });

  it.effect('uses caller-supplied outputs without any discovery', () =>
    Effect.gen(function* () {
      const rounds = roundMap();
      yield* runLatexdiffForRun({
        ...baseRequest,
        outputsByRound: rounds,
      });

      expect(mocks.runLatexdiffFromMetadata).toHaveBeenCalledWith(
        expect.objectContaining({ rounds }),
      );
      expect(mocks.scanRunDirForOutputs).not.toHaveBeenCalled();
      expect(mocks.discoverLatestRunOutputs).not.toHaveBeenCalled();
    }),
  );

  it.effect(
    'scopes a valid runId to a run-dir scan before metadata discovery',
    () =>
      Effect.gen(function* () {
        mocks.scanRunDirForOutputs.mockReturnValue(Effect.succeed(roundMap()));

        const result = yield* runLatexdiffForRun({
          ...baseRequest,
          runId: 'abc123',
        });

        expect(result.runId).toBe('abc123');
        expect(mocks.scanRunDirForOutputs).toHaveBeenCalledWith(
          'abc123',
          'paper.tex',
          undefined,
          'test',
          baseRequest.filesystem,
        );
        expect(mocks.discoverLatestRunOutputs).not.toHaveBeenCalled();
        expect(mocks.runLatexdiffFromMetadata).toHaveBeenCalled();
      }),
  );

  it.effect(
    'does not fall back to auto-discovery when a pinned runId scan misses',
    () =>
      Effect.gen(function* () {
        mocks.scanRunDirForOutputs.mockReturnValue(Effect.succeed(null));

        const result = yield* runLatexdiffForRun({
          ...baseRequest,
          runId: 'abc123',
        });

        expect(result.outcome.results).toEqual([]);
        expect(mocks.discoverLatestRunOutputs).not.toHaveBeenCalled();
        expect(mocks.runLatexdiffFromMetadata).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    'ignores an invalid runId without scanning or auto-discovering',
    () =>
      Effect.gen(function* () {
        const result = yield* runLatexdiffForRun({
          ...baseRequest,
          runId: 'not-hex!',
        });

        expect(result.outcome.results).toEqual([]);
        expect(mocks.scanRunDirForOutputs).not.toHaveBeenCalled();
        expect(mocks.discoverLatestRunOutputs).not.toHaveBeenCalled();
      }),
  );

  it.effect('auto-discovers by agent/model/input when no runId is given', () =>
    Effect.gen(function* () {
      mocks.discoverLatestRunOutputs.mockReturnValue(
        Effect.succeed({
          runId: 'def456',
          rounds: roundMap(),
        }),
      );

      const result = yield* runLatexdiffForRun({ ...baseRequest });

      expect(result.runId).toBe('def456');
      expect(mocks.discoverLatestRunOutputs).toHaveBeenCalledWith(
        runDiscovery,
        {
          agent: 'revise',
          model: 'claude-opus-4-8',
          inputFile: 'paper.tex',
        },
        'test',
        baseRequest.filesystem,
      );
      expect(mocks.runLatexdiffFromMetadata).toHaveBeenCalled();
    }),
  );

  // Save-as-copy files beside the source are user files, not workflow outputs.
  it.effect(
    'reports no diff operations when auto-discovery finds nothing',
    () =>
      Effect.gen(function* () {
        mocks.discoverLatestRunOutputs.mockReturnValue(Effect.succeed(null));

        const result = yield* runLatexdiffForRun({ ...baseRequest });

        expect(result.outcome.results).toEqual([]);
        expect(mocks.runLatexdiffFromMetadata).not.toHaveBeenCalled();
      }),
  );
});

// #10635: runLatexdiffForRun names the latexdiff runtime channel once
// for the whole run, so a line any discovery step writes lands on it.
describe('runLatexdiffForRun diagnostics', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Debug mode on: the Effect logger drops `Debug` entries otherwise, and
    // this assertion is about the channel, not that gate.
    await installPlatform({ config: { 'texra.logger.debugMode': true } });
    mocks.runLatexdiffFromMetadata.mockReturnValue(
      Effect.succeed(EMPTY_OUTCOME),
    );
  });

  afterEach(() => {
    setLogSink(null);
    vi.restoreAllMocks();
  });

  it.effect('names the latexdiff runtime channel on discovery lines', () =>
    Effect.gen(function* () {
      mocks.scanRunDirForOutputs.mockReturnValue(Effect.succeed(roundMap()));
      const logs = captureLogEntries();

      yield* runLatexdiffForRun({
        ...baseRequest,
        runId: 'abc123',
      });

      expect(
        logs.has('DEBUG', 'test', 'Using run-dir scan outputs from run abc123'),
      ).toBe(true);
    }).pipe(Effect.provide(effectDiagnosticsLayer)),
  );
});

describe('normalizeRunLatexdiffOutputsByRound', () => {
  it('keeps a valid round record', () => {
    const first = createOutputFile({ round: 1 });
    const second = createOutputFile({ round: 2 });

    expect(
      normalizeRunLatexdiffOutputsByRound({
        2: [second],
        1: [first],
        3: [],
      }),
    ).toEqual({ 1: [first], 2: [second], 3: [] });
  });

  it('falls back to null for malformed command payloads', () => {
    const valid = createOutputFile({ round: 1 });
    expect(normalizeRunLatexdiffOutputsByRound('not-rounds')).toBeNull();
    expect(normalizeRunLatexdiffOutputsByRound(null)).toBeNull();
    expect(normalizeRunLatexdiffOutputsByRound([1, 2, 3])).toBeNull();
    expect(
      normalizeRunLatexdiffOutputsByRound({
        1: [valid, { not: 'an output file' }],
      }),
    ).toBeNull();
    expect(
      normalizeRunLatexdiffOutputsByRound({ '1.5': [valid], 1: [valid] }),
    ).toBeNull();
  });
});
