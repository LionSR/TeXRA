// Node imports
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';

// Third-party imports
import * as NodePath from '@effect/platform-node/NodePath';
import { it } from '@effect/vitest';
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Path,
} from 'effect';
import { FetchHttpClient, type HttpClient } from 'effect/unstable/http';
import { afterEach, describe, expect, vi } from 'vitest';

// Local imports
import { ArxivProcessor } from '@latex/arxivProcessor';
import { setLogSink } from '@logger/logSink';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

const tempDirs = useTempDirs();
const SOURCE_URL = 'https://arxiv.org/src/2404.12175';

/** The node platform plus the fetch-backed HTTP client each test's
 *  {@link onFetch} seam feeds. */
const httpPlatformLayer = Layer.merge(nodePlatformLayer, FetchHttpClient.layer);

/** Answer the download's requests from `fetchMock`. */
const onFetch =
  (fetchMock: typeof fetch) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.provideService(self, FetchHttpClient.Fetch, fetchMock);

/**
 * The context filesystem, with every `remove` recorded before it runs and
 * every `open` observed: the partial-download delete and the writer close are
 * two of the three events the interruption order assertion pins. `started`
 * completes once the first chunk is written, so an interrupt lands after the
 * body reader exists.
 */
function recordingFsLayer(
  events: string[],
  started: Deferred.Deferred<void>,
): Layer.Layer<FileSystem.FileSystem | Path.Path | HttpClient.HttpClient> {
  const hooked = Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (fs): FileSystem.FileSystem => ({
      ...fs,
      remove: (target, options) => {
        events.push('partial-deleted');
        return fs.remove(target, options);
      },
      open: (target, options) =>
        Effect.gen(function* () {
          // Registered before the open, so this finalizer runs after the
          // handle's own close (scope finalizers run last-in, first-out):
          // 'writer-closed' marks the moment the handle is closed.
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => events.push('writer-closed')),
          );
          const file = yield* fs.open(target, options);
          // The node handle is a class instance: delegate through its
          // prototype chain and override only `writeAll`.
          const observed: FileSystem.File = Object.assign(Object.create(file), {
            writeAll: (buffer: Uint8Array) =>
              file
                .writeAll(buffer)
                .pipe(
                  Effect.andThen(Deferred.done(started, Exit.void)),
                  Effect.asVoid,
                ),
          });
          return observed;
        }),
    })),
  ).pipe(Layer.provide(nodePlatformLayer));
  return Layer.mergeAll(hooked, NodePath.layer, FetchHttpClient.layer);
}

afterEach(async () => {
  setLogSink(null);
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

describe('arXiv source download filenames', () => {
  setupPlatform({});

  it.live(
    'uses the supplied project root when checking downloaded sources',
    () =>
      Effect.gen(function* () {
        const workspaceRoot = yield* Effect.promise(() =>
          makeTempDir('texra-arxiv-project-', tempDirs),
        );
        // An old-style ID's slash is flattened into the directory name
        // rather than nesting the paper one level deeper.
        const sourceDirectory = path.join(
          workspaceRoot,
          'References/math_0501234',
        );
        yield* Effect.promise(async () => {
          await fs.mkdir(sourceDirectory, { recursive: true });
          await fs.writeFile(
            path.join(sourceDirectory, 'main.tex'),
            'project source',
          );
        });
        const result = yield* ArxivProcessor.downloadSource('math/0501234', {
          workspaceRoot,
          formatter: null,
          autoIndent: false,
        });
        expect(result).toEqual({ path: sourceDirectory, alreadyExisted: true });
      }).pipe(Effect.provide(httpPlatformLayer)),
  );

  it.live(
    'streams a gzip-only source through gunzip into main.tex and drops the archive',
    () =>
      Effect.gen(function* () {
        const workspaceRoot = yield* Effect.promise(() =>
          makeTempDir('texra-arxiv-gzip-', tempDirs),
        );
        const tex = '\\documentclass{article}\n'.repeat(4096);
        const fetchMock = vi.fn(
          async () =>
            new Response(gzipSync(tex), {
              headers: {
                'content-disposition': 'attachment; filename="source.gz"',
              },
            }),
        );
        const result = yield* ArxivProcessor.downloadSource('2404.12175', {
          workspaceRoot,
          formatter: null,
          autoIndent: false,
        }).pipe(onFetch(fetchMock));
        const paperDir = path.join(workspaceRoot, 'References/2404.12175');
        expect(result).toEqual({ path: paperDir, alreadyExisted: false });
        expect(yield* Effect.promise(() => fs.readdir(paperDir))).toStrictEqual(
          ['main.tex'],
        );
        expect(
          yield* Effect.promise(() =>
            fs.readFile(path.join(paperDir, 'main.tex'), 'utf8'),
          ),
        ).toBe(tex);
      }).pipe(Effect.provide(httpPlatformLayer)),
  );

  it.live(
    'closes an interrupted body writer before deleting its partial download',
    () =>
      Effect.gen(function* () {
        const destBasePath = yield* tempSourceBase;
        const started = yield* Deferred.make<void>();
        const events: string[] = [];
        let body: ReadableStreamDefaultController<Uint8Array> | undefined;
        const fetchMock = vi.fn(
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
        );

        const fiber = yield* ArxivProcessor.downloadFile(
          SOURCE_URL,
          destBasePath,
        ).pipe(
          onFetch(fetchMock),
          Effect.provide(recordingFsLayer(events, started)),
          Effect.forkChild,
        );
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
        const downloadedPath = yield* ArxivProcessor.downloadFile(
          SOURCE_URL,
          destBasePath,
          5000,
        ).pipe(onFetch(fetchMock));

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
      }).pipe(Effect.provide(httpPlatformLayer)),
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
      const downloadedPath = yield* ArxivProcessor.downloadFile(
        SOURCE_URL,
        destBasePath,
        5000,
      ).pipe(onFetch(fetchMock));

      expect(attempt).toBe(2);
      expect(downloadedPath).toBe(destBasePath);
    }).pipe(Effect.provide(httpPlatformLayer)),
  );

  it.effect('does not retry a permanent 400 response', () =>
    Effect.gen(function* () {
      const destBasePath = yield* tempSourceBase;
      const fetchMock = vi.fn(async () => new Response(null, { status: 400 }));
      const error = yield* Effect.flip(
        ArxivProcessor.downloadFile(SOURCE_URL, destBasePath, 5000).pipe(
          onFetch(fetchMock),
        ),
      );
      expect(error.message).toContain('HTTP 400');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(httpPlatformLayer)),
  );
});
