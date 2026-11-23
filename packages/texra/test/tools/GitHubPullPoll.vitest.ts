// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Layer, Option } from 'effect';
import { HttpClientRequest } from 'effect/http';
import { describe, expect } from 'vitest';

// Local imports - platform
import { Secrets } from '@texra-ai/worldline/plugins';

// Local imports - test support
import { FakeSecrets } from '@test/support/FakePlatform';
import { scriptedHttpClientLayer } from '@test/support/fetchTestUtils';

// Local imports - tools
import { GitHubRateLimitError } from '@texra/tools/github/githubClient';
import type { GhCheckRun } from '@texra/tools/github/prTypes';
import { pollPull, type PullState } from '@texra/tools/github/pullPoller';
import { HARNESS_APP } from '@test/support/FakePlatform';

/** The epoch second GitHub names as the rate limit's reset. */
const RESET_AT = 1_800_000_000;

/**
 * GitHub as the poll sees it: every pull request read answers 304 (nothing
 * changed), and the annotation read hits the primary rate limit.
 */
const github = scriptedHttpClientLayer((request) =>
  new URL(request.url).pathname.endsWith('/annotations')
    ? new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
        status: 403,
        headers: {
          'Content-Type': 'application/json',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(RESET_AT),
        },
      })
    : new Response(null, { status: 304 }),
);

/** The services the GitHub client requires, over the scripted API. */
const githubServices = Layer.merge(
  Secrets.layer(new FakeSecrets(), HARNESS_APP.client),
  github.layer,
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
      ci: 'passed',
      checkRunsCache: undefined,
      pendingAnnotationRuns: [run],
    },
    mergeableState: undefined,
  };
}

describe('pull request poll annotation drain', () => {
  it.effect(
    'fails the poll on an annotation rate limit, so the subscription waits for the reset',
    () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          pollPull(
            { _tag: 'pull', owner: 'owner', repo: 'repo', number: 7 },
            Effect.void,
            priorWithQueuedRun(createCheckRun(42)),
          ),
        );

        expect(failure).toStrictEqual(
          new GitHubRateLimitError({ resetAt: RESET_AT }),
        );
        expect(
          github.requests.some((request) =>
            Option.getOrThrow(HttpClientRequest.toUrl(request)).href.endsWith(
              '/check-runs/42/annotations?per_page=100&page=1',
            ),
          ),
        ).toBe(true);
      }).pipe(Effect.provide(githubServices)),
  );
});
