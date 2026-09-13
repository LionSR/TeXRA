import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { Effect } from 'effect';

import { it } from '@effect/vitest';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import type { LatexRunDiscoveryPort } from '@latex/latexdiff/runDiscovery';
import { effectDiagnosticsLayer } from '@logger/effectDiagnostics';
import { setLogSink } from '@logger/logSink';
import { platform } from '@platform/platform';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import type { RunId } from '@shared/schemas';
import { captureLogEntries } from '@test/support/logSinkCapture';
import { installPlatform } from '@test/support/setupPlatform';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

// A run may have generated files even when no output facts were recorded.
const mocks = vi.hoisted(() => ({
  findRunDir: vi.fn(),
  readRunOutputs: vi.fn(),
}));

vi.mock('@utils/files/runStorageFs', async (importActual) => ({
  ...(await importActual<typeof import('@utils/files/runStorageFs')>()),
  findRunDir: mocks.findRunDir,
}));

const { discoverLatestRunOutputs } =
  await import('@latex/latexdiff/outputDiscovery');
const { scanRunDirForOutputs } =
  await import('@latex/latexdiff/runOutputFiles');

function matchingRun(id: RunId) {
  return {
    id,
    timestamp: '2026-01-01T00:00:00.000Z',
    agent: 'polish',
    model: 'deepseek',
    inputFiles: ['paper.tex'],
  };
}

function discoveryWith(
  entries: readonly ReturnType<typeof matchingRun>[],
): LatexRunDiscoveryPort {
  return {
    listAgentRuns: () => Effect.succeed(entries),
    readRunOutputs: mocks.readRunOutputs,
  };
}

const MATCHING_QUERY = {
  agent: 'polish',
  model: 'deepseek',
  inputFile: 'paper.tex',
} as const;

describe('discoverLatestRunOutputs', () => {
  const tempDirs = useTempDirs();

  beforeEach(async () => {
    vi.clearAllMocks();
    await installPlatform({}, { fs: nodeFilesystem });
    mocks.readRunOutputs.mockReturnValue(Effect.succeed({}));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it.effect(
    'falls back to an on-disk run-dir scan when the run recorded no outputs',
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

        const discovery = discoveryWith([
          matchingRun('exec-headless' as RunId),
        ]);
        mocks.findRunDir.mockResolvedValue(runDir);

        const result = yield* discoverLatestRunOutputs(
          discovery,
          MATCHING_QUERY,
          'test',
          platform().fs,
        );

        expect(result?.runId).toBe('exec-headless');
        expect(
          Object.keys(result?.rounds ?? {})
            .map(Number)
            .sort((a, b) => a - b),
        ).toEqual([0, 1]);
        expect(mocks.findRunDir).toHaveBeenCalledWith('exec-headless');
      }),
  );

  it.effect(
    'reads the run outputs under the run id instead of rebuilding an identity from configuration (#9590 A1)',
    () =>
      Effect.gen(function* () {
        const discovery = discoveryWith([
          matchingRun('exec-registered' as RunId),
        ]);
        const rounds = { 0: [] };
        mocks.readRunOutputs.mockReturnValue(Effect.succeed(rounds));

        const result = yield* discoverLatestRunOutputs(
          discovery,
          MATCHING_QUERY,
          'test',
          platform().fs,
        );

        expect(mocks.readRunOutputs).toHaveBeenCalledWith('exec-registered');
        expect(result).toEqual({ runId: 'exec-registered', rounds });
        expect(mocks.findRunDir).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    'returns null when neither the recorded outputs nor the run directory has outputs',
    () =>
      Effect.gen(function* () {
        const emptyDir = yield* Effect.promise(() =>
          makeTempDir('texra-latexdiff-', tempDirs),
        );

        const discovery = discoveryWith([matchingRun('exec-empty' as RunId)]);
        mocks.findRunDir.mockResolvedValue(emptyDir);

        const result = yield* discoverLatestRunOutputs(
          discovery,
          MATCHING_QUERY,
          'test',
          platform().fs,
        );

        expect(result).toBeNull();
      }),
  );

  it.effect(
    'propagates an unreadable run index instead of choosing different outputs',
    () =>
      Effect.gen(function* () {
        const discovery: LatexRunDiscoveryPort = {
          listAgentRuns: () => Effect.fail(new Error('run index unreadable')),
          readRunOutputs: mocks.readRunOutputs,
        };

        const failure = yield* Effect.flip(
          discoverLatestRunOutputs(
            discovery,
            MATCHING_QUERY,
            'test',
            platform().fs,
          ),
        );

        expect(failure.message).toBe('run index unreadable');
      }),
  );
});

describe('outputDiscovery diagnostics', () => {
  const tempDirs = useTempDirs();

  /** The scan under the logger production installs, so entries reach the sink. */
  const runScan = (): Effect.Effect<unknown> =>
    scanRunDirForOutputs(
      'abc123' as RunId,
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
        // Hand-rolled because the fake host's filesystem cannot inject a per-path
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
