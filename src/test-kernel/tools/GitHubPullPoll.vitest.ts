// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

// Local imports - platform
import { Secrets } from '@texra-ai/harness/host';

// Local imports - test support
import { FakeSecrets } from '@test/support/FakePlatform';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';

// Local imports - tools
import { GitHubRateLimitError } from '@texra/tools/github/githubClient';
import type { GhCheckRun } from '@texra/tools/github/prTypes';
import { pollPull, type PullState } from '@texra/tools/github/pullPoller';

const mocks = vi.hoisted(() => ({
  fetchAnnotations: vi.fn(),
  ghGet: vi.fn(),
}));

// Stub the GitHub transport at its module boundaries; the importOriginal
// spreads keep the real error classes and the check-runs walk.
vi.mock('@texra/tools/github/checkRunsClient', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@texra/tools/github/checkRunsClient')
  >()),
  fetchAnnotations: mocks.fetchAnnotations,
}));
vi.mock('@texra/tools/github/githubClient', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@texra/tools/github/githubClient')
  >()),
  ghGet: mocks.ghGet,
}));

/** The services the GitHub client requires; the client itself is mocked. */
const githubServices = Layer.merge(
  Secrets.layer(new FakeSecrets()),
  testHttpClientLayer,
);

function createCheckRun(id: number): GhCheckRun {
  return {
    id,
    name: 'lint',
    status: 'completed',
    conclusion: 'success',
    html_url: `https://example.test/checks/${id}`,
    completed_at: '2026-05-12T00:00:00Z',
    output: { annotations_count: 1 },
  };
}

/** A pull request polled before, with one annotated run queued. */
function priorWithQueuedRun(run: GhCheckRun): PullState {
  return {
    etags: {},
    issueComments: undefined,
    reviewComments: undefined,
    reviews: undefined,
    lastFailedCheckKeys: new Set(),
    lastAnnotationKeys: new Set(),
    head: {
      sha: 'abcdef1234567890',
      ciStarted: true,
      ciComplete: true,
      ciPassed: true,
      checkRunsCache: undefined,
      pendingAnnotationRuns: [run],
    },
    mergeableState: undefined,
  };
}

describe('pull request poll annotation drain', () => {
  beforeEach(() => {
    mocks.fetchAnnotations.mockReset();
    mocks.ghGet.mockReset();
  });

  it.effect(
    'fails the poll on an annotation rate limit, so the subscription waits for the reset',
    () =>
      Effect.gen(function* () {
        mocks.ghGet.mockReturnValue(Effect.succeed({ status: 304 }));
        const rateLimit = new GitHubRateLimitError({ resetAt: 1_800_000_000 });
        mocks.fetchAnnotations.mockReturnValue(Effect.fail(rateLimit));

        const failure = yield* Effect.flip(
          pollPull(
            { _tag: 'pull', owner: 'owner', repo: 'repo', number: 7 },
            Effect.void,
            priorWithQueuedRun(createCheckRun(42)),
          ),
        );

        expect(failure).toBe(rateLimit);
      }).pipe(Effect.provide(githubServices)),
  );
});
