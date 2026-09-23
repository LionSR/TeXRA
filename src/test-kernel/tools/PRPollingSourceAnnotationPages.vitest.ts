// Suites for the annotation-page budget path of @tools/github
// (PRPollingSource pagination + AnnotationFetchBudget token bucket).

// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

// Local imports - platform
import { Secrets } from '@platform/secrets';

// Local imports - test support
import { FakeSecrets } from '@test/support/FakePlatform';

// Local imports - tools
import { AnnotationFetchBudget } from '@tools/github/annotationFetchBudget';
import { fetchAnnotations } from '@tools/github/checkRunsClient';
import {
  PRPollingSource,
  type PRSubscriptionState,
} from '@tools/github/PRPollingSource';
import type { GhCheckAnnotation, GhCheckRun } from '@tools/github/prTypes';
import type { PollHookRejected } from '@tools/github/PollingSourceBase';

// Local imports - test fixtures
import {
  createPRCurrentShaState,
  createPRSubscriptionState,
} from '../support/prPollingSourceState';

const mocks = vi.hoisted(() => ({
  ghGet: vi.fn(),
}));

// Stub the GitHub client at its module boundary. The importOriginal spread
// keeps the real error classes, so the source's own instanceof checks run
// against the classes production reaches, not against look-alikes.
vi.mock('@tools/github/githubClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tools/github/githubClient')>()),
  ghGet: mocks.ghGet,
}));

// ---------------------------------------------------------------------------
// PRPollingSourceAnnotationPages
// ---------------------------------------------------------------------------

interface AnnotationDrainSource {
  drainAnnotationQueues(
    entries: ReadonlyArray<readonly [string, PRSubscriptionState]>,
    now?: number,
  ): Effect.Effect<void, PollHookRejected>;
  has(key: string): boolean;
}

/**
 * The process secret store behind the GitHub client. The client itself is
 * mocked here, so no member is called; the layer satisfies the requirement
 * the host root provides in production.
 */
const secretsLayer = Secrets.layer(new FakeSecrets());

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

function checkRun(id: number): GhCheckRun {
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

function drainState(runs: GhCheckRun[]): PRSubscriptionState {
  return createPRSubscriptionState({
    currentShaState: createPRCurrentShaState('abcdef1234567890', {
      pendingAnnotationRuns: runs,
    }),
  });
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
        new AnnotationFetchBudget(2, 60_000),
      );

      expect(annotations).toHaveLength(101);
      expect(annotations.at(-1)?.annotation_level).toBe('failure');
      expect(mocks.ghGet).toHaveBeenCalledTimes(2);
      expect(mocks.ghGet.mock.calls.map((call) => call[0])).toEqual([
        '/repos/owner/repo/check-runs/42/annotations?per_page=100&page=1',
        '/repos/owner/repo/check-runs/42/annotations?per_page=100&page=2',
      ]);
    }).pipe(Effect.provide(secretsLayer)),
  );

  it.effect('caps annotation pagination for malformed full pages', () =>
    Effect.gen(function* () {
      mocks.ghGet.mockReturnValue(
        Effect.succeed({ status: 200, data: fullWarningPage() }),
      );

      const annotations = yield* fetchAnnotations(
        'owner',
        'repo',
        42,
        new AnnotationFetchBudget(50, 60_000),
      );

      expect(annotations).toHaveLength(5000);
      expect(mocks.ghGet).toHaveBeenCalledTimes(50);
      expect(mocks.ghGet.mock.calls.at(-1)?.[0]).toBe(
        '/repos/owner/repo/check-runs/42/annotations?per_page=100&page=50',
      );
    }).pipe(Effect.provide(secretsLayer)),
  );

  it.effect('counts annotation budget by endpoint page', () =>
    Effect.gen(function* () {
      mocks.ghGet.mockReturnValue(
        Effect.succeed({ status: 200, data: fullWarningPage() }),
      );

      const error = yield* Effect.flip(
        fetchAnnotations(
          'owner',
          'repo',
          42,
          new AnnotationFetchBudget(1, 60_000),
        ),
      );

      expect(error).toMatchObject({
        message: expect.stringContaining('Annotation fetch budget exhausted'),
      });
      expect(mocks.ghGet).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(secretsLayer)),
  );

  it.effect(
    'leaves queued annotation runs in place when the page budget is exhausted',
    () =>
      Effect.gen(function* () {
        const source =
          new PRPollingSource() as unknown as AnnotationDrainSource;
        source.has = vi.fn().mockReturnValue(true);
        yield* PRPollingSource.resetAnnotationFetchBudgetForTests(0);
        const runs = [checkRun(7), checkRun(8)];
        const state = drainState(runs);

        yield* source.drainAnnotationQueues([['owner/repo#7', state]]);

        expect(mocks.ghGet).not.toHaveBeenCalled();
        expect(state.currentShaState?.pendingAnnotationRuns).toEqual(runs);
      }),
  );
});

// ---------------------------------------------------------------------------
// AnnotationFetchBudget
// ---------------------------------------------------------------------------

describe('AnnotationFetchBudget', () => {
  it.effect('does not stall refills after the clock moves backward', () =>
    Effect.gen(function* () {
      const budget = new AnnotationFetchBudget(1, 1000);

      expect(yield* budget.tryClaim(1000)).toBe(true);
      expect(yield* budget.tryClaim(900)).toBe(false);
      expect(yield* budget.tryClaim(1900)).toBe(true);
    }),
  );
});
