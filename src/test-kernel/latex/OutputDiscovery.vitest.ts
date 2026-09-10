import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { Effect } from 'effect';

import { it } from '@effect/vitest';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import type { LatexExecutionDiscoveryPort } from '@latex/latexdiff/executionDiscovery';
import { effectDiagnosticsLayer } from '@logger/effectDiagnostics';
import { setLogSink } from '@logger/logSink';
import { platform } from '@platform/platform';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { captureLogEntries } from '@test/support/logSinkCapture';
import { installPlatform } from '@test/support/setupPlatform';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

// A run may have generated files even when no output facts were recorded.
const mocks = vi.hoisted(() => ({
  findRunDir: vi.fn(),
  read: vi.fn(),
}));

vi.mock('@utils/files/runStorageFs', async (importActual) => ({
  ...(await importActual<typeof import('@utils/files/runStorageFs')>()),
  findRunDir: mocks.findRunDir,
}));

const snapshots = { read: mocks.read };
const { discoverLatestRunOutputs } =
  await import('@latex/latexdiff/outputDiscovery');
const { scanRunDirForOutputs } =
  await import('@latex/latexdiff/runOutputFiles');

function matchingExecution(id: string) {
  return {
    id,
    timestamp: '2026-01-01T00:00:00.000Z',
    agent: 'polish',
    model: 'deepseek',
    inputFiles: ['paper.tex'],
  };
}

function discoveryWith(
  entries: readonly ReturnType<typeof matchingExecution>[],
): {
  discovery: LatexExecutionDiscoveryPort;
  readStreamId: ReturnType<typeof vi.fn>;
} {
  const readStreamId = vi.fn(async (_id: string) => undefined);
  return {
    discovery: {
      listAgentRuns: () => Effect.succeed(entries),
      readStreamId: (id) =>
        Effect.tryPromise({
          try: () => readStreamId(id),
          catch: (error) => error as Error,
        }),
    },
    readStreamId,
  };
}

const MATCHING_QUERY = {
  agent: 'polish',
  model: 'deepseek',
  inputFile: 'paper.tex',
} as const;

describe('discoverLatestExecutionOutputs', () => {
  const tempDirs = useTempDirs();

  beforeEach(async () => {
    vi.clearAllMocks();
    await installPlatform({}, { fs: nodeFilesystem });
    mocks.read.mockReturnValue(Effect.succeed({ outputFilesByRound: {} }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it.effect(
    'falls back to an on-disk run-dir scan when the stream-tab snapshot is empty',
    () =>
      Effect.gen(function* () {
        const runDir = yield* Effect.promise(async () => {
          const dir = await makeTempDir('texra-latexdiff-', tempDirs);
          for (const round of ['r0', 'r1']) {
            await mkdir(path.join(dir, round), { recursive: true });
            await writeFile(
              path.join(dir, round, 'paper.tex'),
              `\\documentclass{article}\\begin{document}${round}\\end{document}`,
            );
          }
          return dir;
        });

        const { discovery } = discoveryWith([
          matchingExecution('exec-headless'),
        ]);
        mocks.findRunDir.mockResolvedValue(runDir);

        const result = yield* discoverLatestRunOutputs(
          discovery,
          snapshots,
          MATCHING_QUERY,
          'test',
          platform().fs,
        );

        expect(result?.executionId).toBe('exec-headless');
        expect(
          Object.keys(result?.rounds ?? {})
            .map(Number)
            .sort((a, b) => a - b),
        ).toEqual([0, 1]);
        expect(mocks.findRunDir).toHaveBeenCalledWith('exec-headless');
      }),
  );

  it.effect(
    'reads outputs under the registered stream identity instead of rebuilding it from configuration (#9590 A1)',
    () =>
      Effect.gen(function* () {
        const { discovery, readStreamId } = discoveryWith([
          matchingExecution('exec-registered'),
        ]);
        // Registered under a stream the agent/model config would NOT derive.
        readStreamId.mockResolvedValue('polish@earlierModel#exec-registered');
        const rounds = { 0: [] };
        mocks.read.mockReturnValue(
          Effect.succeed({ outputFilesByRound: rounds }),
        );

        const result = yield* discoverLatestRunOutputs(
          discovery,
          snapshots,
          MATCHING_QUERY,
          'test',
          platform().fs,
        );

        expect(readStreamId).toHaveBeenCalledWith('exec-registered');
        expect(mocks.read).toHaveBeenCalledWith(
          'polish@earlierModel#exec-registered',
        );
        expect(result).toEqual({ executionId: 'exec-registered', rounds });
        expect(mocks.findRunDir).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    'returns null when neither the snapshot nor the run directory has outputs',
    () =>
      Effect.gen(function* () {
        const emptyDir = yield* Effect.promise(() =>
          makeTempDir('texra-latexdiff-', tempDirs),
        );

        const { discovery } = discoveryWith([matchingExecution('exec-empty')]);
        mocks.findRunDir.mockResolvedValue(emptyDir);

        const result = yield* discoverLatestRunOutputs(
          discovery,
          snapshots,
          MATCHING_QUERY,
          'test',
          platform().fs,
        );

        expect(result).toBeNull();
      }),
  );

  it.effect(
    'propagates an unreadable execution index instead of choosing different outputs',
    () =>
      Effect.gen(function* () {
        const discovery: LatexExecutionDiscoveryPort = {
          listAgentRuns: () =>
            Effect.fail(new Error('execution index unreadable')),
          readStreamId: () => Effect.succeed(undefined),
        };

        const failure = yield* Effect.flip(
          discoverLatestRunOutputs(
            discovery,
            snapshots,
            MATCHING_QUERY,
            'test',
            platform().fs,
          ),
        );

        expect(failure.message).toBe('execution index unreadable');
      }),
  );
});

describe('outputDiscovery diagnostics', () => {
  const tempDirs = useTempDirs();

  /** The scan under the logger production installs, so entries reach the sink. */
  const runScan = (): Effect.Effect<unknown> =>
    scanRunDirForOutputs(
      'abc123',
      'paper.tex',
      undefined,
      'test',
      platform().fs,
    ).pipe(Effect.provide(effectDiagnosticsLayer));

  beforeEach(async () => {
    vi.clearAllMocks();
    // clearAllMocks keeps mockRejectedValue implementations — reset so a
    // rejection pinned by one test cannot leak into the next.
    mocks.findRunDir.mockReset();
    await installPlatform({}, { fs: nodeFilesystem });
  });

  afterEach(async () => {
    setLogSink(null);
    vi.restoreAllMocks();
  });

  // #10634: a failed persisted-state read degrades the invocation to the
  // workspace scan — fallback discipline requires warn, not debug.
  it.effect(
    'warns on the pinned channel when the run-dir scan cannot read run storage',
    () =>
      Effect.gen(function* () {
        mocks.findRunDir.mockRejectedValue(new Error('storage index corrupt'));
        const logs = captureLogEntries();

        const result = yield* runScan();

        expect(result).toBeNull();
        expect(
          logs.has(
            'WARN',
            'test',
            'RunDir scan for abc123 failed: storage index corrupt',
          ),
        ).toBe(true);
        expect(logs.at('DEBUG')).toHaveLength(0);
      }),
  );

  // #10635: an unreadable round subtree warns while the remaining rounds
  // still scan, on the channel the whole scan was annotated with.
  it.effect(
    'warns on the pinned channel for an unreadable round dir and keeps the readable rounds',
    () =>
      Effect.gen(function* () {
        const { runDir, unreadable } = yield* Effect.promise(async () => {
          const dir = await makeTempDir('texra-latexdiff-', tempDirs);
          await mkdir(path.join(dir, 'r0'), { recursive: true });
          await mkdir(path.join(dir, 'r1'), { recursive: true });
          await writeFile(
            path.join(dir, 'r1', 'paper.tex'),
            '\\documentclass{article}\\begin{document}x\\end{document}',
          );
          return { runDir: dir, unreadable: path.join(dir, 'r0') };
        });
        // Hand-rolled because FakeFileSystemProvider cannot inject a per-path
        // readDirectory failure — it seeds files, not fault rules.
        yield* Effect.promise(() =>
          installPlatform(
            {},
            {
              fs: {
                ...nodeFilesystem,
                readDirectory: async (target: string) => {
                  if (target === unreadable) {
                    throw new Error('EACCES: permission denied');
                  }
                  return nodeFilesystem.readDirectory(target);
                },
              },
            },
          ),
        );
        mocks.findRunDir.mockResolvedValue(runDir);
        const logs = captureLogEntries();

        const result = yield* runScan();

        expect(Object.keys((result as object) ?? {}).map(Number)).toEqual([1]);
        expect(
          logs.has(
            'WARN',
            'test',
            `Skipping unreadable directory '${unreadable}'`,
          ),
        ).toBe(true);
      }),
  );
});
