import { chmod, mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { Effect } from 'effect';

import { it } from '@effect/vitest';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import type { LatexRunDiscoveryPort } from '@latex/latexdiff/runDiscovery';
import { effectDiagnosticsLayer } from '@logger/effectDiagnostics';
import { setLogSink } from '@logger/logSink';
import type { RunId } from '@shared/schemas';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { captureLogEntries } from '@test/support/logSinkCapture';
import { installPlatform } from '@test/support/setupPlatform';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

// A run may have generated files even when no output facts were recorded.
const mocks = vi.hoisted(() => ({
  findRunDirUnder: vi.fn(),
  readRunOutputs: vi.fn(),
}));

vi.mock('@utils/files/runStorageFs', async (importActual) => ({
  ...(await importActual<typeof import('@utils/files/runStorageFs')>()),
  findRunDirUnder: mocks.findRunDirUnder,
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
    await installPlatform({});
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
        mocks.findRunDirUnder.mockReturnValue(Effect.succeed(runDir));

        const result = yield* discoverLatestRunOutputs(
          discovery,
          testWorkspaceRoots().storage,
          testWorkspaceRoots().workspace,
          MATCHING_QUERY,
          'test',
        ).pipe(Effect.provide(nodePlatformLayer));

        expect(result?.runId).toBe('exec-headless');
        expect(
          Object.keys(result?.rounds ?? {})
            .map(Number)
            .sort((a, b) => a - b),
        ).toEqual([0, 1]);
        expect(mocks.findRunDirUnder).toHaveBeenCalledWith(
          testWorkspaceRoots().storage,
          'exec-headless',
        );
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
          testWorkspaceRoots().storage,
          testWorkspaceRoots().workspace,
          MATCHING_QUERY,
          'test',
        ).pipe(Effect.provide(nodePlatformLayer));

        expect(mocks.readRunOutputs).toHaveBeenCalledWith('exec-registered');
        expect(result).toEqual({ runId: 'exec-registered', rounds });
        expect(mocks.findRunDirUnder).not.toHaveBeenCalled();
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
        mocks.findRunDirUnder.mockReturnValue(Effect.succeed(emptyDir));

        const result = yield* discoverLatestRunOutputs(
          discovery,
          testWorkspaceRoots().storage,
          testWorkspaceRoots().workspace,
          MATCHING_QUERY,
          'test',
        ).pipe(Effect.provide(nodePlatformLayer));

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
            testWorkspaceRoots().storage,
            testWorkspaceRoots().workspace,
            MATCHING_QUERY,
            'test',
          ).pipe(Effect.provide(nodePlatformLayer)),
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
      testWorkspaceRoots().storage,
      testWorkspaceRoots().workspace,
      'paper.tex',
      undefined,
      'test',
    ).pipe(
      Effect.provide(effectDiagnosticsLayer),
      Effect.provide(nodePlatformLayer),
    );

  beforeEach(async () => {
    vi.clearAllMocks();
    // clearAllMocks keeps mockReturnValue implementations — reset so a
    // failure pinned by one test cannot leak into the next.
    mocks.findRunDirUnder.mockReset();
    await installPlatform({});
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
        mocks.findRunDirUnder.mockReturnValue(
          Effect.fail(new Error('storage index corrupt')),
        );
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
  //
  // POSIX only: the unreadable directory is made with mode bits, and Windows
  // ignores them — `chmod(dir, 0o000)` leaves the directory listable there, so
  // the scan finds nothing to warn about. The behaviour under test is the
  // scan's, not the filesystem's, and is covered wherever mode bits apply.
  it.effect.skipIf(process.platform === 'win32')(
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
        // A real unreadable directory: the listing is `readdir` now, so the
        // failure it must survive is the filesystem's own EACCES. The mode is
        // restored either way so the temp-dir cleanup can still remove it.
        yield* Effect.promise(() => chmod(unreadable, 0o000));
        mocks.findRunDirUnder.mockReturnValue(Effect.succeed(runDir));
        const logs = captureLogEntries();

        const result = yield* runScan().pipe(
          Effect.ensuring(Effect.promise(() => chmod(unreadable, 0o700))),
        );

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
