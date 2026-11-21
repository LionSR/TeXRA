// Node imports
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Layer, Stream } from 'effect';
import { Tar } from 'effect/encoding';
import { FetchHttpClient } from 'effect/http';
import { afterEach, describe, expect, vi } from 'vitest';

// Local imports
import { setLogSink } from '@texra-ai/harness/node';
import { downloadArxivSource } from '@latex/arxivProcessor';
import { createFakeWorkspaceRoots } from '@test/support/FakePlatform';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
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
  it.live(
    'refuses an archive entry that already exists at the root, then places a clean one',
    () =>
      Effect.gen(function* () {
        const workspaceRoot = yield* Effect.promise(() =>
          makeTempDir('texra-arxiv-root-', tempDirs),
        );
        const archive = yield* Stream.make(
          Tar.file('main.tex', 'arxiv'),
          Tar.directory('figures'),
          Tar.file('figures/a.txt', 'fig'),
        ).pipe(
          Stream.pipeThroughChannel(Tar.encode()),
          Stream.runCollect,
          Effect.map((chunks) => Buffer.concat(chunks)),
        );
        yield* Effect.promise(() =>
          fs.writeFile(path.join(workspaceRoot, 'main.tex'), 'mine'),
        );
        const download = downloadArxivSource('2404.12175', {
          roots: createFakeWorkspaceRoots({ workspaceRoot }),
          indent: false,
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
