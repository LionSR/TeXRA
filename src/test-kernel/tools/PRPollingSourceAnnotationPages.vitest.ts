// Suite for the annotation-page path of @tools/github (checkRunsClient
// pagination before level filtering).

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

// Local imports - platform
import { Secrets } from '@platform/secrets';

// Local imports - test support
import { FakeSecrets } from '@test/support/FakePlatform';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';

// Local imports - tools
import { fetchAnnotations } from '@texra/tools/github/checkRunsClient';
import type { GhCheckAnnotation } from '@texra/tools/github/prTypes';

const mocks = vi.hoisted(() => ({
  ghGet: vi.fn(),
}));

// Stub the GitHub client at its module boundary. The importOriginal spread
// keeps the real error classes, so the source's own instanceof checks run
// against the classes production reaches, not against look-alikes.
vi.mock('@texra/tools/github/githubClient', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@texra/tools/github/githubClient')
  >()),
  ghGet: mocks.ghGet,
}));

/**
 * The process secret store behind the GitHub client. The client itself is
 * mocked here, so no member is called; the layer satisfies the requirement
 * the host root provides in production.
 */
const secretsLayer = Layer.merge(
  Secrets.layer(new FakeSecrets()),
  testHttpClientLayer,
);

function annotation(
  level: GhCheckAnnotation['annotation_level'],
  index: number,
): GhCheckAnnotation {
  return {
    path: 'blueprint/src/chapter.tex',
    start_line: index + 1,
    end_line: index + 1,
    annotation_level: level,
    message: `${level} ${index}`,
  };
}

/** A full 100-entry warning page, which keeps pagination going. */
function fullWarningPage(): GhCheckAnnotation[] {
  return Array.from({ length: 100 }, (_, index) =>
    annotation('warning', index),
  );
}

describe('PRPollingSource annotation pagination', () => {
  beforeEach(() => {
    mocks.ghGet.mockReset();
  });

  it.effect('fetches later annotation pages before level filtering runs', () =>
    Effect.gen(function* () {
      mocks.ghGet
        .mockReturnValueOnce(
          Effect.succeed({ status: 200, data: fullWarningPage() }),
        )
        .mockReturnValueOnce(
          Effect.succeed({
            status: 200,
            data: [annotation('failure', 100)],
          }),
        );

      const annotations = yield* fetchAnnotations(
        'owner',
        'repo',
        42,
        Effect.void,
      );

      expect(annotations).toHaveLength(101);
      expect(annotations.at(-1)?.annotation_level).toBe('failure');
      expect(mocks.ghGet.mock.calls.map((call) => call[0])).toEqual([
        '/repos/owner/repo/check-runs/42/annotations?per_page=100&page=1',
        '/repos/owner/repo/check-runs/42/annotations?per_page=100&page=2',
      ]);
    }).pipe(Effect.provide(secretsLayer)),
  );
});
