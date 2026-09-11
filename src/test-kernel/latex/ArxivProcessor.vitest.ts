// Node imports
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Cause, Deferred, Effect, Exit, Fiber } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

// Local imports
import {
  ArxivProcessor,
  resolveArxivPaperDirectoryRelative,
} from '@latex/arxivProcessor';
import { effectDiagnosticsLayer } from '@logger/effectDiagnostics';
import { setLogSink } from '@logger/logSink';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { captureLogEntries } from '@test/support/logSinkCapture';
import { installPlatform, setupPlatform } from '@test/support/setupPlatform';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { AbsoluteFS } from '@utils/files/absoluteFS';

const tempDirs = useTempDirs();
const SOURCE_URL = 'https://arxiv.org/src/2404.12175';

afterEach(async () => {
  setLogSink(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const tempSourceBase = Effect.promise(() =>
  makeTempDir('texra-arxiv-', tempDirs),
).pipe(Effect.map((dir) => path.join(dir, 'source')));

function sourceResponse(status = 200): Response {
  return new Response('source contents', {
    status,
    headers: {
      'content-disposition': 'attachment; filename="source"',
      'content-type': 'application/x-gzip',
    },
  });
}

describe('arXiv processor paths', () => {
  it.each<{
    id: string;
    options?: Parameters<typeof resolveArxivPaperDirectoryRelative>[1];
    expected: string;
  }>([
    { id: '2404.12175', expected: 'References/2404.12175' },
    { id: 'math/0501234', expected: 'References/math_0501234' },
    { id: '2404.12175', options: { destination: 'root' }, expected: '.' },
  ])(
    'keeps arxiv destinations id-specific ($id → $expected)',
    ({ id, options, expected }) => {
      expect(resolveArxivPaperDirectoryRelative(id, options)).toBe(expected);
    },
  );
});

describe('arXiv processor logger channel', () => {
  /**
   * Debug mode on: the Effect logger drops `Debug` entries otherwise, and
   * these assertions are about which channel an entry lands on, not that gate.
   */
  const withDebugPlatform = Effect.promise(() =>
    installPlatform({ config: { 'texra.logger.debugMode': true } }),
  ).pipe(Effect.asVoid);

  /** The logger production installs, so entries reach the captured sink. */
  const withDiagnostics = <A, E, R>(
    self: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> => Effect.provide(self, effectDiagnosticsLayer);

  // #7347 renamed the exported singleton to PascalCase and accidentally
  // changed the channel string too. It is rendered as the `[channel]` prefix
  // on every line this class emits, so it must stay lowercase for log filters
  // that match `[arxivProcessor]`.
  //
  // `it.live`: the 429 retry backoff sleeps on the effect clock, which the
  // TestClock `it.effect` installs never advances on its own.
  it.live('emits download retry logs on the "arxivProcessor" channel', () =>
    Effect.gen(function* () {
      yield* withDebugPlatform;
      const logs = captureLogEntries();
      const destBasePath = yield* tempSourceBase;
      let attempt = 0;
      const fetchMock = vi.fn(async () => {
        attempt += 1;
        return attempt === 1
          ? new Response(null, { status: 429 })
          : sourceResponse();
      });
      vi.stubGlobal('fetch', fetchMock);

      const downloadedPath = yield* ArxivProcessor.downloadFile(
        SOURCE_URL,
        destBasePath,
        5000,
      );

      expect(downloadedPath).toBe(destBasePath);
      expect(
        logs.has('DEBUG', 'arxivProcessor', 'Download attempt failed'),
      ).toBe(true);
    }).pipe(withDiagnostics),
  );

  it.effect('logs extraction failures on the owner channel', () =>
    Effect.gen(function* () {
      const logs = captureLogEntries();
      const dir = yield* Effect.promise(() =>
        makeTempDir('texra-arxiv-', tempDirs),
      );
      const missingTar = path.join(dir, 'missing.tar');

      const fallback = yield* ArxivProcessor.extractTarFile(missingTar, dir);

      expect(fallback.success).toBe(false);
      expect(
        logs.has('ERROR', 'arxivProcessor', 'Failed to extract tar file'),
      ).toBe(true);
    }).pipe(withDiagnostics),
  );
});

describe('arXiv source download filenames', () => {
  setupPlatform({}, { fs: nodeFilesystem });

  it.live(
    'closes an interrupted body writer before deleting its partial download',
    () =>
      Effect.gen(function* () {
        const destBasePath = yield* tempSourceBase;
        const started = yield* Deferred.make<void>();
        const events: string[] = [];
        const createWriteStream = AbsoluteFS.createWriteStream.bind(AbsoluteFS);
        vi.spyOn(AbsoluteFS, 'createWriteStream').mockImplementation(
          (...args) => {
            const writer = createWriteStream(...args);
            writer.once('close', () => events.push('writer-closed'));
            writer.once('open', () => Deferred.doneUnsafe(started, Exit.void));
            return writer;
          },
        );
        const deleteFile = AbsoluteFS.delete.bind(AbsoluteFS);
        vi.spyOn(AbsoluteFS, 'delete').mockImplementation(async (...args) => {
          events.push('partial-deleted');
          return deleteFile(...args);
        });
        let body: ReadableStreamDefaultController<Uint8Array> | undefined;
        vi.stubGlobal(
          'fetch',
          vi.fn(
            async () =>
              new Response(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    body = controller;
                    controller.enqueue(
                      new TextEncoder().encode('partial source'),
                    );
                  },
                  cancel() {
                    events.push('body-cancelled');
                  },
                }),
                {
                  headers: {
                    'content-disposition': 'attachment; filename="source"',
                  },
                },
              ),
          ),
        );

        const fiber = yield* ArxivProcessor.downloadFile(
          SOURCE_URL,
          destBasePath,
        ).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        const exit = yield* Fiber.await(fiber);
        // End an unowned old body after observing the result, so a failing
        // regression does not leave its original writer alive in the suite.
        if (!events.includes('body-cancelled')) body?.close();
        expect(
          Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause),
        ).toBe(true);
        expect(events).toStrictEqual([
          'body-cancelled',
          'writer-closed',
          'partial-deleted',
        ]);
        expect(
          yield* Effect.promise(() =>
            fs.access(destBasePath).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false);
      }),
  );

  it.effect(
    'does not infer a missing header filename when it matches the base path',
    () =>
      Effect.gen(function* () {
        const destBasePath = yield* tempSourceBase;
        const fetchMock = vi.fn(async () => sourceResponse());
        vi.stubGlobal('fetch', fetchMock);

        const downloadedPath = yield* ArxivProcessor.downloadFile(
          SOURCE_URL,
          destBasePath,
          5000,
        );

        expect(downloadedPath).toBe(destBasePath);
        const contents = yield* Effect.promise(() =>
          fs.readFile(destBasePath, 'utf8'),
        );
        expect(contents).toBe('source contents');
        const accessError = yield* Effect.flip(
          Effect.tryPromise({
            try: () => fs.access(`${destBasePath}.gz`),
            catch: (cause) => cause,
          }),
        );
        expect(accessError).toBeInstanceOf(Error);
      }),
  );
});

describe('arXiv source download retry classification', () => {
  // `it.live`: the 429 retry backoff sleeps on the effect clock, which the
  // TestClock `it.effect` installs never advances on its own.
  it.live('retries a 429 rate limit instead of aborting immediately', () =>
    Effect.gen(function* () {
      const destBasePath = yield* tempSourceBase;
      let attempt = 0;
      const fetchMock = vi.fn(async () => {
        attempt += 1;
        return attempt === 1
          ? new Response(null, { status: 429 })
          : sourceResponse();
      });
      vi.stubGlobal('fetch', fetchMock);

      const downloadedPath = yield* ArxivProcessor.downloadFile(
        SOURCE_URL,
        destBasePath,
        5000,
      );

      expect(attempt).toBe(2);
      expect(downloadedPath).toBe(destBasePath);
    }),
  );

  it.effect('does not retry a permanent 400 response', () =>
    Effect.gen(function* () {
      const destBasePath = yield* tempSourceBase;
      const fetchMock = vi.fn(async () => new Response(null, { status: 400 }));
      vi.stubGlobal('fetch', fetchMock);

      const error = yield* Effect.flip(
        ArxivProcessor.downloadFile(SOURCE_URL, destBasePath, 5000),
      );
      expect(error.message).toContain('HTTP 400');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }),
  );
});
