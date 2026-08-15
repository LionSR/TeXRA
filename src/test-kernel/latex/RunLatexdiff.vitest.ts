import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LaTeXdiffService } from '@latex/latexdiff';
import type { LatexExecutionDiscoveryPort } from '@latex/latexdiff/executionDiscovery';
import { normalizeRunLatexdiffOutputsByRound } from '@latex/latexdiff/runLatexdiff';
import type { OutputFileInfo, RoundIndexed } from '@shared/schemas';
import { createOutputFile } from '../support/ProgressControllerHarnesses';

const mocks = vi.hoisted(() => ({
  scanRunDirForOutputs: vi.fn(),
  discoverLatestExecutionOutputs: vi.fn(),
  runLatexdiffFromMetadata: vi.fn(),
  runLatexdiffViaWorkspaceScan: vi.fn(),
}));

vi.mock('@latex/latexdiff/outputDiscovery', () => ({
  scanRunDirForOutputs: mocks.scanRunDirForOutputs,
  discoverLatestExecutionOutputs: mocks.discoverLatestExecutionOutputs,
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

const METADATA_OUTCOME = { results: [], totalOperations: 1 };
const SCAN_OUTCOME = { results: [], totalOperations: 2 };

function roundMap(): RoundIndexed<OutputFileInfo> {
  return { 1: [] as OutputFileInfo[] };
}

const executionDiscovery: LatexExecutionDiscoveryPort = {
  listAgentRuns: async () => [],
  readStreamId: async () => undefined,
};

const baseRequest = {
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
    mocks.runLatexdiffFromMetadata.mockResolvedValue(METADATA_OUTCOME);
    mocks.runLatexdiffViaWorkspaceScan.mockResolvedValue(SCAN_OUTCOME);
  });

  it('uses caller-supplied outputs without any discovery', async () => {
    const rounds = roundMap();
    const result = await runLatexdiffForExecution({
      ...baseRequest,
      outputsByRound: rounds,
    });

    expect(result.source).toBe('metadata');
    expect(mocks.runLatexdiffFromMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ rounds }),
    );
    expect(mocks.scanRunDirForOutputs).not.toHaveBeenCalled();
    expect(mocks.discoverLatestExecutionOutputs).not.toHaveBeenCalled();
  });

  it('scopes a valid runId to a run-dir scan before metadata discovery', async () => {
    mocks.scanRunDirForOutputs.mockResolvedValue(roundMap());

    const result = await runLatexdiffForExecution({
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
    );
    expect(mocks.discoverLatestExecutionOutputs).not.toHaveBeenCalled();
    expect(mocks.runLatexdiffFromMetadata).toHaveBeenCalled();
  });

  it('does not fall back to auto-discovery when a pinned runId scan misses', async () => {
    mocks.scanRunDirForOutputs.mockResolvedValue(null);

    const result = await runLatexdiffForExecution({
      ...baseRequest,
      runId: 'abc123',
    });

    expect(result.source).toBe('workspace-scan');
    expect(mocks.discoverLatestExecutionOutputs).not.toHaveBeenCalled();
    expect(mocks.runLatexdiffViaWorkspaceScan).toHaveBeenCalled();
  });

  it('ignores an invalid runId without scanning or auto-discovering', async () => {
    const result = await runLatexdiffForExecution({
      ...baseRequest,
      runId: 'not-hex!',
    });

    expect(result.source).toBe('workspace-scan');
    expect(mocks.scanRunDirForOutputs).not.toHaveBeenCalled();
    expect(mocks.discoverLatestExecutionOutputs).not.toHaveBeenCalled();
    expect(mocks.runLatexdiffViaWorkspaceScan).toHaveBeenCalled();
  });

  it('auto-discovers by agent/model/input when no runId is given', async () => {
    mocks.discoverLatestExecutionOutputs.mockResolvedValue({
      executionId: 'def456',
      rounds: roundMap(),
    });

    const result = await runLatexdiffForExecution({ ...baseRequest });

    expect(result.source).toBe('metadata');
    expect(result.executionId).toBe('def456');
    expect(mocks.discoverLatestExecutionOutputs).toHaveBeenCalledWith(
      executionDiscovery,
      {
        agent: 'revise',
        model: 'claude-opus-4-8',
        inputFile: 'paper.tex',
      },
      'test',
    );
    expect(mocks.runLatexdiffFromMetadata).toHaveBeenCalled();
  });

  it('falls back to a workspace scan when auto-discovery finds nothing', async () => {
    mocks.discoverLatestExecutionOutputs.mockResolvedValue(null);

    const result = await runLatexdiffForExecution({ ...baseRequest });

    expect(result.source).toBe('workspace-scan');
    expect(mocks.runLatexdiffViaWorkspaceScan).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'revise',
        model: 'claude-opus-4-8',
        inputFile: 'paper.tex',
      }),
    );
  });
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
