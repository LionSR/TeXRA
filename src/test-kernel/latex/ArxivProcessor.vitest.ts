// Node imports
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { FetchHttpClient } from 'effect/http';
import * as tar from 'tar';
import { afterEach, describe, expect, vi } from 'vitest';

// Local imports
import { ArxivProcessor } from '@latex/arxivProcessor';
import { setLogSink } from '@logger/logSink';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

const tempDirs = useTempDirs();

/** The node platform plus the fetch-backed HTTP client each test's
 *  {@link onFetch} seam feeds. */
const httpPlatformLayer = Layer.merge(nodePlatformLayer, FetchHttpClient.layer);

/** Answer the download's requests from `fetchMock`. */
const onFetch =
  (fetchMock: typeof fetch) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.provideService(self, FetchHttpClient.Fetch, fetchMock);

afterEach(async () => {
  setLogSink(null);
  vi.restoreAllMocks();
});

describe('arXiv source download filenames', () => {
  setupPlatform({});

  it.live(
    'refuses an archive entry that already exists at the root, then places a clean one',
    () =>
      Effect.gen(function* () {
        const workspaceRoot = yield* Effect.promise(() =>
          makeTempDir('texra-arxiv-root-', tempDirs),
        );
        const archive = yield* Effect.promise(async () => {
          const srcDir = await makeTempDir('texra-arxiv-tar-', tempDirs);
          await fs.mkdir(path.join(srcDir, 'figures'));
          await fs.writeFile(path.join(srcDir, 'main.tex'), 'arxiv');
          await fs.writeFile(path.join(srcDir, 'figures/a.txt'), 'fig');
          const tarPath = path.join(srcDir, 'source.tar');
          await tar.c({ cwd: srcDir, file: tarPath }, ['main.tex', 'figures']);
          await fs.writeFile(path.join(workspaceRoot, 'main.tex'), 'mine');
          return fs.readFile(tarPath);
        });
        const download = ArxivProcessor.downloadSource('2404.12175', {
          workspaceRoot,
          formatter: null,
          autoIndent: false,
          destination: 'root',
        }).pipe(
          onFetch(
            vi.fn(
              async () =>
                new Response(archive, {
                  headers: {
                    'content-disposition': 'attachment; filename="source.tar"',
                  },
                }),
            ),
          ),
        );
        const listRoot = Effect.promise(async () =>
          (await fs.readdir(workspaceRoot)).sort(),
        );
        const error = yield* Effect.flip(download);
        expect(error.message).toBe(
          `Target already exists: ${path.join(workspaceRoot, 'main.tex')}`,
        );
        expect(yield* listRoot).toStrictEqual(['main.tex']);
        expect(
          yield* Effect.promise(() =>
            fs.readFile(path.join(workspaceRoot, 'main.tex'), 'utf8'),
          ),
        ).toBe('mine');

        yield* Effect.promise(() =>
          fs.rm(path.join(workspaceRoot, 'main.tex')),
        );
        yield* download;
        expect(yield* listRoot).toStrictEqual(['figures', 'main.tex']);
        expect(
          yield* Effect.promise(() =>
            fs.readFile(path.join(workspaceRoot, 'figures/a.txt'), 'utf8'),
          ),
        ).toBe('fig');
      }).pipe(Effect.provide(httpPlatformLayer)),
  );
});
