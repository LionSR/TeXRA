// Standard library imports
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

// Third-party imports
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { installPlatform } from '@test/support/setupPlatform';
import { cleanupTempDirs, makeTempDir } from '@test/support/tempDirPlatform';

// `discoverLatestExecutionOutputs` matches a run by agent/model/input and then
// reads its per-round outputs. Headless `texra run` executions persist those
// outputs on disk but never write the progress-view stream-tab snapshot, so the
// snapshot read comes back empty. These mocks reproduce that case: a matching
// execution whose stream-tab snapshot is empty while its run directory holds
// r0/r1 outputs on disk (the same source the `--run-id` path scans).
const mocks = vi.hoisted(() => ({
  listExecutions: vi.fn(),
  getExecutionStore: vi.fn(),
  findRunDir: vi.fn(),
  readOutputFiles: vi.fn(),
}));

vi.mock('@agent/storage', async (importActual) => ({
  ...(await importActual<typeof import('@agent/storage')>()),
  listExecutions: mocks.listExecutions,
  getExecutionStore: mocks.getExecutionStore,
}));

vi.mock('@utils/files/runStorageFs', async (importActual) => ({
  ...(await importActual<typeof import('@utils/files/runStorageFs')>()),
  findRunDir: mocks.findRunDir,
}));

vi.mock('@transcript', async (importActual) => {
  // A class (not an arrow) so `new StreamSnapshotStore()` is constructable.
  class FakeStreamSnapshotStore {
    readOutputFiles = mocks.readOutputFiles;
  }
  return {
    ...(await importActual<typeof import('@transcript')>()),
    StreamSnapshotStore: FakeStreamSnapshotStore,
  };
});

const { discoverLatestExecutionOutputs } =
  await import('@latex/latexdiff/outputDiscovery');

function matchingExecution(id: string) {
  return {
    kind: 'run',
    identity: { kind: 'agent', agent: 'polish' },
    id,
    timestamp: '2026-01-01T00:00:00.000Z',
    record: {
      agent: 'polish',
      model: 'deepseek',
      inputFiles: ['paper.tex'],
    },
  };
}

const MATCHING_QUERY = {
  agent: 'polish',
  model: 'deepseek',
  inputFile: 'paper.tex',
} as const;

describe('discoverLatestExecutionOutputs', () => {
  const tempDirs: string[] = [];

  beforeEach(async () => {
    vi.clearAllMocks();
    await installPlatform({}, { fs: nodeFilesystem });
    // Headless executions have no registered stream identity and no
    // stream-tab snapshot.
    mocks.getExecutionStore.mockReturnValue({
      readMeta: async () => null,
    } as never);
    mocks.readOutputFiles.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await cleanupTempDirs(tempDirs);
  });

  it('falls back to an on-disk run-dir scan when the stream-tab snapshot is empty', async () => {
    const runDir = await makeTempDir('texra-latexdiff-', tempDirs);
    for (const round of ['r0', 'r1']) {
      await mkdir(path.join(runDir, round), { recursive: true });
      await writeFile(
        path.join(runDir, round, 'paper.tex'),
        `\\documentclass{article}\\begin{document}${round}\\end{document}`,
      );
    }

    mocks.listExecutions.mockResolvedValue([
      matchingExecution('exec-headless'),
    ]);
    mocks.findRunDir.mockResolvedValue(runDir);

    const result = await discoverLatestExecutionOutputs(MATCHING_QUERY);

    expect(result?.executionId).toBe('exec-headless');
    expect(
      Object.keys(result?.rounds ?? {})
        .map(Number)
        .sort((a, b) => a - b),
    ).toEqual([0, 1]);
    expect(mocks.findRunDir).toHaveBeenCalledWith('exec-headless');
  });

  it('reads outputs under the registered stream identity instead of rebuilding it from configuration (#9590 A1)', async () => {
    mocks.listExecutions.mockResolvedValue([
      matchingExecution('exec-registered'),
    ]);
    // Registered under a stream the agent/model config would NOT derive.
    mocks.getExecutionStore.mockReturnValue({
      readMeta: async () => ({
        timestamp: '2026-01-01T00:00:00.000Z',
        streamId: 'polish@earlierModel#exec-registered',
      }),
    } as never);
    const rounds = { 0: [] };
    mocks.readOutputFiles.mockResolvedValue(rounds);

    const result = await discoverLatestExecutionOutputs(MATCHING_QUERY);

    expect(mocks.readOutputFiles).toHaveBeenCalledWith(
      'polish@earlierModel#exec-registered',
    );
    expect(result).toEqual({ executionId: 'exec-registered', rounds });
    expect(mocks.findRunDir).not.toHaveBeenCalled();
  });

  it('returns null when neither the snapshot nor the run directory has outputs', async () => {
    const emptyDir = await makeTempDir('texra-latexdiff-', tempDirs);

    mocks.listExecutions.mockResolvedValue([matchingExecution('exec-empty')]);
    mocks.findRunDir.mockResolvedValue(emptyDir);

    const result = await discoverLatestExecutionOutputs(MATCHING_QUERY);

    expect(result).toBeNull();
  });
});
