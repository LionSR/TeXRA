// Node imports
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

// Local imports
import {
  ArxivProcessor,
  resolveArxivPaperDirectoryRelative,
} from '@latex/arxivProcessor';
import * as logger from '@logger/logUtils';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

const tempDirs = useTempDirs();
const SOURCE_URL = 'https://arxiv.org/src/2404.12175';

afterEach(async () => {
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
  it('defaults the log channel to "arxivProcessor" (stable across the #7347 PascalCase rename)', () => {
    // `channel` is private, but it is the exact value passed to
    // logger.info(this.channel, ...) and rendered as the `[channel]` prefix on
    // every log line this class emits. #7347 renamed the exported singleton to
    // PascalCase and accidentally changed this string too; the channel value
    // must stay lowercase so log filters keep matching `[arxivProcessor]`.
    const channel = (ArxivProcessor as unknown as { channel: string }).channel;
    expect(channel).toBe('arxivProcessor');
  });

  // Spy seam (#10635): the owner getter binds `this.channel` through createLog
  // per call, so a logger-namespace spy must observe the owner channel.
  // `it.live`: the 429 retry backoff sleeps on the effect clock, which the
  // TestClock `it.effect` installs never advances on its own.
  it.live(
    'emits download retry logs through the logger namespace on the owner channel',
    () =>
      Effect.gen(function* () {
        const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
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
        expect(debug).toHaveBeenCalledWith(
          'arxivProcessor',
          expect.stringContaining('Download attempt failed'),
        );
      }),
  );

  it.effect('logs extraction failures on the owner channel', () =>
    Effect.gen(function* () {
      const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
      const dir = yield* Effect.promise(() =>
        makeTempDir('texra-arxiv-', tempDirs),
      );
      const missingTar = path.join(dir, 'missing.tar');

      const fallback = yield* ArxivProcessor.extractTarFile(missingTar, dir);

      expect(fallback.success).toBe(false);
      expect(error).toHaveBeenCalledWith(
        'arxivProcessor',
        expect.stringContaining('Failed to extract tar file'),
      );
    }),
  );
});

describe('arXiv source download filenames', () => {
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
