// Standard library imports
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// Third-party imports
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanupTempDirs } from '@test/support/tempDirPlatform';

// `discoverLatestExecutionOutputs` matches a run by agent/model/input and then
// reads its per-round outputs. Headless `texra run` executions persist those
// outputs on disk but never write the progress-view stream-tab snapshot, so the
// snapshot read comes back empty. These mocks reproduce that case: a matching
// execution whose stream-tab snapshot is empty while its run directory holds
// r0/r1 outputs on disk (the same source the `--run-id` path scans).
const mocks = vi.hoisted(() => ({
  listExecutions: vi.fn(),
  findRunDir: vi.fn(),
  readOutputFiles: vi.fn(),
}));

vi.mock('@agent/storage', async (importActual) => ({
  ...(await importActual<typeof import('@agent/storage')>()),
  listExecutions: mocks.listExecutions,
}));

vi.mock('@utils/files', async (importActual) => ({
  ...(await importActual<typeof import('@utils/files')>()),
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
    kind: 'agent',
    id,
    timestamp: '2026-01-01T00:00:00.000Z',
    agentConfig: {
      agent: 'polish',
      model: 'deepseek',
      inputFiles: ['paper.tex'],
    },
  };
}

describe('discoverLatestExecutionOutputs', () => {
  const tempDirs: string[] = [];

  async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'texra-latexdiff-'));
    tempDirs.push(dir);
    return dir;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    const [{ initPlatform }, { nodeFilesystem }, { createFakePlatform }] =
      await Promise.all([
        import('@platform/platform'),
        import('@platform/defaults/nodeFilesystem'),
        import('@test/support/FakePlatform'),
      ]);
    initPlatform(createFakePlatform({}, { fs: nodeFilesystem }));
    // No stream-tab snapshot exists for headless runs.
    mocks.readOutputFiles.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await cleanupTempDirs(tempDirs);
  });

  it('falls back to an on-disk run-dir scan when the stream-tab snapshot is empty', async () => {
    const runDir = await makeTempDir();
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

    const result = await discoverLatestExecutionOutputs({
      agent: 'polish',
      model: 'deepseek',
      inputFile: 'paper.tex',
    });

    expect(result?.executionId).toBe('exec-headless');
    expect(
      Object.keys(result?.rounds ?? {})
        .map(Number)
        .sort((a, b) => a - b),
    ).toEqual([0, 1]);
    expect(mocks.findRunDir).toHaveBeenCalledWith('exec-headless');
  });

  it('returns null when neither the snapshot nor the run directory has outputs', async () => {
    const emptyDir = await makeTempDir();

    mocks.listExecutions.mockResolvedValue([matchingExecution('exec-empty')]);
    mocks.findRunDir.mockResolvedValue(emptyDir);

    const result = await discoverLatestExecutionOutputs({
      agent: 'polish',
      model: 'deepseek',
      inputFile: 'paper.tex',
    });

    expect(result).toBeNull();
  });
});
