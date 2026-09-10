import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';
import type { LaTeXdiffService } from '@latex/latexdiff';
import type { LatexExecutionDiscoveryPort } from '@latex/latexdiff/executionDiscovery';
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
  discoverLatestExecutionOutputs: vi.fn(),
  runLatexdiffFromMetadata: vi.fn(),
  runLatexdiffViaWorkspaceScan: vi.fn(),
}));

vi.mock('@latex/latexdiff/runOutputFiles', () => ({
  scanRunDirForOutputs: mocks.scanRunDirForOutputs,
}));

vi.mock('@latex/latexdiff/outputDiscovery', () => ({
  discoverLatestRunOutputs: mocks.discoverLatestExecutionOutputs,
}));

vi.mock('@latex/latexdiff/diffOperations', () => ({
  runLatexdiffFromMetadata: mocks.runLatexdiffFromMetadata,
  runLatexdiffViaWorkspaceScan: mocks.runLatexdiffViaWorkspaceScan,
}));

const { runLatexdiffForExecution } =
  await import('@latex/latexdiff/runLatexdiff');

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

const executionDiscovery: LatexExecutionDiscoveryPort = {
  listAgentRuns: () => Effect.succeed([]),
  readStreamId: () => Effect.succeed(undefined),
};

const snapshots = { read: vi.fn() };

const baseRequest = {
  filesystem: { readDirectory: vi.fn(), isSymlink: vi.fn() },
  snapshots,
  agent: 'revise',
  model: 'claude-opus-4-8',
  inputFile: 'paper.tex',
  executionDiscovery,
  generateBetweenRoundDiffs: false,
  latexdiff,
  progress: { report: () => undefined },
} as const;

describe('runLatexdiffForExecution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runLatexdiffFromMetadata.mockReturnValue(
      Effect.succeed(EMPTY_OUTCOME),
    );
    mocks.runLatexdiffViaWorkspaceScan.mockReturnValue(
      Effect.succeed(EMPTY_OUTCOME),
    );
  });

  it.effect('uses caller-supplied outputs without any discovery', () =>
    Effect.gen(function* () {
      const rounds = roundMap();
      const result = yield* runLatexdiffForExecution({
        ...baseRequest,
        outputsByRound: rounds,
      });

      expect(result.source).toBe('metadata');
      expect(mocks.runLatexdiffFromMetadata).toHaveBeenCalledWith(
        expect.objectContaining({ rounds }),
      );
      expect(mocks.scanRunDirForOutputs).not.toHaveBeenCalled();
      expect(mocks.discoverLatestExecutionOutputs).not.toHaveBeenCalled();
    }),
  );

  it.effect(
    'scopes a valid runId to a run-dir scan before metadata discovery',
    () =>
      Effect.gen(function* () {
        mocks.scanRunDirForOutputs.mockReturnValue(Effect.succeed(roundMap()));

        const result = yield* runLatexdiffForExecution({
          ...baseRequest,
          runId: 'abc123',
        });

        expect(result.source).toBe('run-dir-scan');
        expect(result.executionId).toBe('abc123');
        expect(mocks.scanRunDirForOutputs).toHaveBeenCalledWith(
          'abc123',
          'paper.tex',
          undefined,
          'test',
          baseRequest.filesystem,
        );
        expect(mocks.discoverLatestExecutionOutputs).not.toHaveBeenCalled();
        expect(mocks.runLatexdiffFromMetadata).toHaveBeenCalled();
      }),
  );

  it.effect(
    'does not fall back to auto-discovery when a pinned runId scan misses',
    () =>
      Effect.gen(function* () {
        mocks.scanRunDirForOutputs.mockReturnValue(Effect.succeed(null));

        const result = yield* runLatexdiffForExecution({
          ...baseRequest,
          runId: 'abc123',
        });

        expect(result.source).toBe('workspace-scan');
        expect(mocks.discoverLatestExecutionOutputs).not.toHaveBeenCalled();
        expect(mocks.runLatexdiffViaWorkspaceScan).toHaveBeenCalled();
      }),
  );

  it.effect(
    'ignores an invalid runId without scanning or auto-discovering',
    () =>
      Effect.gen(function* () {
        const result = yield* runLatexdiffForExecution({
          ...baseRequest,
          runId: 'not-hex!',
        });

        expect(result.source).toBe('workspace-scan');
        expect(mocks.scanRunDirForOutputs).not.toHaveBeenCalled();
        expect(mocks.discoverLatestExecutionOutputs).not.toHaveBeenCalled();
        expect(mocks.runLatexdiffViaWorkspaceScan).toHaveBeenCalled();
      }),
  );

  it.effect('auto-discovers by agent/model/input when no runId is given', () =>
    Effect.gen(function* () {
      mocks.discoverLatestExecutionOutputs.mockReturnValue(
        Effect.succeed({
          executionId: 'def456',
          rounds: roundMap(),
        }),
      );

      const result = yield* runLatexdiffForExecution({ ...baseRequest });

      expect(result.source).toBe('metadata');
      expect(result.executionId).toBe('def456');
      expect(mocks.discoverLatestExecutionOutputs).toHaveBeenCalledWith(
        executionDiscovery,
        snapshots,
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

  it.effect(
    'falls back to a workspace scan when auto-discovery finds nothing',
    () =>
      Effect.gen(function* () {
        mocks.discoverLatestExecutionOutputs.mockReturnValue(
          Effect.succeed(null),
        );

        const result = yield* runLatexdiffForExecution({ ...baseRequest });

        expect(result.source).toBe('workspace-scan');
        expect(mocks.runLatexdiffViaWorkspaceScan).toHaveBeenCalledWith(
          expect.objectContaining({
            agent: 'revise',
            model: 'claude-opus-4-8',
            inputFile: 'paper.tex',
          }),
        );
      }),
  );
});

// #10635: runLatexdiffForExecution names the latexdiff runtime channel once
// for the whole run, so a line any discovery step writes lands on it.
describe('runLatexdiffForExecution diagnostics', () => {
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

      const result = yield* runLatexdiffForExecution({
        ...baseRequest,
        runId: 'abc123',
      });

      expect(result.source).toBe('run-dir-scan');
      expect(
        logs.has(
          'DEBUG',
          'test',
          'Using run-dir scan outputs from execution abc123',
        ),
      ).toBe(true);
    }).pipe(Effect.provide(effectDiagnosticsLayer)),
  );
});

describe('normalizeRunLatexdiffOutputsByRound', () => {
  it('keeps non-empty round-record entries, dropping empty rounds', () => {
    const first = createOutputFile({ round: 1 });
    const second = createOutputFile({ round: 2 });

    expect(
      normalizeRunLatexdiffOutputsByRound({
        2: [second],
        1: [first],
        3: [],
      }),
    ).toEqual({ 1: [first], 2: [second] });
  });

  it('falls back to null for malformed command payloads', () => {
    expect(normalizeRunLatexdiffOutputsByRound('not-rounds')).toBeNull();
    expect(normalizeRunLatexdiffOutputsByRound(null)).toBeNull();
    expect(normalizeRunLatexdiffOutputsByRound([1, 2, 3])).toBeNull();
  });

  it('drops malformed items within an otherwise-valid round record', () => {
    const valid = createOutputFile({ round: 1 });

    expect(
      normalizeRunLatexdiffOutputsByRound({
        1: [valid, { not: 'an output file' }],
      }),
    ).toEqual({ 1: [valid] });
  });

  it('drops non-integer round keys while retaining valid rounds', () => {
    const valid = createOutputFile({ round: 1 });

    expect(
      normalizeRunLatexdiffOutputsByRound({
        '1.5': [createOutputFile({ round: 1.5 })],
        1: [valid],
      }),
    ).toEqual({ 1: [valid] });
  });
});
