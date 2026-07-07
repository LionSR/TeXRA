// Third-party imports
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

// Local imports - tools
import type {
  GhCheckRun,
  GhIssueComment,
  GhPullRequest,
  GhReview,
  GhReviewComment,
} from '@tools/github/prTypes';

// Local imports - test support
import { mockGitHubClient } from '../support/githubClientMock';

interface CurrentShaState {
  sha: string;
  ciStarted: boolean;
  ciComplete: boolean;
  ciPassed: boolean;
  checkRunsCache?: {
    pages: Map<number, { etag?: string; runs: GhCheckRun[] }>;
    lastTotalCount: number;
  };
  pendingAnnotationRuns: GhCheckRun[];
}

interface CiStartedState {
  pr: { owner: string; repo: string; pullNumber: number };
  slug: string;
  listeners: Set<(text: string) => void>;
  initialized: boolean;
  issueComments: TestDedupedResource<GhIssueComment>;
  reviewComments: TestDedupedResource<GhReviewComment>;
  reviews: TestDedupedResource<GhReview>;
  lastFailedCheckKeys: Set<string>;
  lastAnnotationKeys: Set<string>;
  headSha: string | undefined;
  currentShaState: CurrentShaState | undefined;
  state: 'open' | 'closed' | undefined;
  merged: boolean;
  mergeableState: string | undefined;
  etags: {
    pr?: string;
    issueComments?: string;
    reviewComments?: string;
    reviews?: string;
  };
  lastSuccessAt: number;
  consecutiveFailures: number;
  skipPollUntilMs: number;
}

interface CiStartedSource {
  pollOne(key: string, state: CiStartedState): Promise<void>;
}

interface TestDedupedResource<T> {
  sinceCursor: string | undefined;
  seed(items: readonly T[]): void;
  diff(items: readonly T[], emit: (item: T) => void): void;
}

const SHA = 'abcdef1234567890';
const OLD_SHA = '1234567890abcdef';
let emitCiStartedEvents = false;

function testDedupedResource<T>(): TestDedupedResource<T> {
  return {
    sinceCursor: undefined,
    seed: vi.fn(),
    diff: vi.fn(),
  };
}

function makeCurrentShaState(
  sha: string,
  overrides: Partial<Omit<CurrentShaState, 'sha'>> = {},
): CurrentShaState {
  return {
    sha,
    ciStarted: false,
    ciComplete: false,
    ciPassed: false,
    checkRunsCache: undefined,
    pendingAnnotationRuns: [],
    ...overrides,
  };
}

function createState(
  events: string[],
  overrides: Partial<CiStartedState> = {},
): CiStartedState {
  const listener = (text: string) => events.push(text);
  return {
    pr: { owner: 'owner', repo: 'repo', pullNumber: 7 },
    slug: 'owner/repo',
    listeners: new Set([listener]),
    initialized: true,
    issueComments: testDedupedResource(),
    reviewComments: testDedupedResource(),
    reviews: testDedupedResource(),
    lastFailedCheckKeys: new Set(),
    lastAnnotationKeys: new Set(),
    headSha: SHA,
    currentShaState: makeCurrentShaState(SHA),
    state: 'open',
    merged: false,
    mergeableState: 'clean',
    etags: {},
    lastSuccessAt: Date.now(),
    consecutiveFailures: 0,
    skipPollUntilMs: 0,
    ...overrides,
  };
}

function prResponse(sha: string): {
  status: 200;
  etag: string;
  data: GhPullRequest;
} {
  return {
    status: 200,
    etag: `pr-${sha}`,
    data: {
      state: 'open',
      merged: false,
      mergeable_state: 'clean',
      head: { sha },
    },
  };
}

function checkRun(id: number, name: string): GhCheckRun {
  return {
    id,
    name,
    status: 'in_progress',
    conclusion: null,
    html_url: `https://example.test/checks/${id}`,
    completed_at: null,
  };
}

function checkRunsResponse(runs: GhCheckRun[]): {
  status: 200;
  etag: string;
  data: { total_count: number; check_runs: GhCheckRun[] };
} {
  return {
    status: 200,
    etag: `checks-${runs.length}`,
    data: {
      total_count: runs.length,
      check_runs: runs,
    },
  };
}

async function createHarness(
  options: {
    emitCiStartedEvents?: boolean;
  } = {},
): Promise<{
  ghGet: Mock;
  source: CiStartedSource;
}> {
  vi.resetModules();
  emitCiStartedEvents = options.emitCiStartedEvents ?? false;
  const ghGet = vi.fn();
  vi.doMock('@utils/config', () => ({
    getConfig: vi.fn((_key: string, defaultValue: unknown) =>
      emitCiStartedEvents ? true : defaultValue,
    ),
  }));
  mockGitHubClient(ghGet);
  const { PRPollingSource } = await import('@tools/github/PRPollingSource');
  return {
    ghGet,
    source: new PRPollingSource() as unknown as CiStartedSource,
  };
}

function queuePollResponses(
  ghGet: Mock,
  sha: string,
  runs: GhCheckRun[],
): void {
  ghGet
    .mockResolvedValueOnce(prResponse(sha))
    .mockResolvedValueOnce({ status: 304 })
    .mockResolvedValueOnce({ status: 304 })
    .mockResolvedValueOnce({ status: 304 })
    .mockResolvedValueOnce(checkRunsResponse(runs));
}

describe('PRPollingSource CI-started events', () => {
  afterEach(() => {
    vi.doUnmock('@tools/github/githubClient');
    vi.doUnmock('@utils/config');
    emitCiStartedEvents = false;
    vi.resetModules();
  });

  it('keeps CI-started events disabled by default while recording observed runs', async () => {
    const { ghGet, source } = await createHarness();
    const events: string[] = [];
    const state = createState(events);

    queuePollResponses(ghGet, SHA, [checkRun(1, 'lint')]);

    await source.pollOne('owner/repo/pulls/7', state);

    expect(events).toEqual([]);
    expect(state.currentShaState?.ciStarted).toBe(true);
  });

  it.each([
    { label: 'while disabled without emitting', enabled: false },
    {
      label: 'without replaying a CI-started event when enabled',
      enabled: true,
    },
  ])('seeds existing check runs $label', async ({ enabled }) => {
    const { ghGet, source } = await createHarness({
      emitCiStartedEvents: enabled,
    });
    const events: string[] = [];
    const state = createState(events, {
      initialized: false,
      headSha: undefined,
      currentShaState: undefined,
      state: undefined,
    });

    queuePollResponses(ghGet, SHA, [checkRun(1, 'lint')]);

    await source.pollOne('owner/repo/pulls/7', state);

    expect(events).toEqual([]);
    expect(state.currentShaState?.sha).toBe(SHA);
    expect(state.currentShaState?.ciStarted).toBe(true);
  });

  it('emits a CI-started event once when check runs first appear', async () => {
    const { ghGet, source } = await createHarness({
      emitCiStartedEvents: true,
    });
    const events: string[] = [];
    const state = createState(events);

    queuePollResponses(ghGet, SHA, [checkRun(1, 'lint'), checkRun(2, 'test')]);

    await source.pollOne('owner/repo/pulls/7', state);

    expect(events).toHaveLength(1);
    expect(events[0]).toContain('CI triggered');
    expect(events[0]).toContain('distinct check names');
    expect(events[0]).not.toContain('workflow');
    expect(state.currentShaState?.ciStarted).toBe(true);

    queuePollResponses(ghGet, SHA, [checkRun(1, 'lint'), checkRun(2, 'test')]);

    await source.pollOne('owner/repo/pulls/7', state);

    expect(events).toHaveLength(1);
  });

  it('resets CI-started state on a new head SHA', async () => {
    const { ghGet, source } = await createHarness({
      emitCiStartedEvents: true,
    });
    const events: string[] = [];
    const state = createState(events, {
      headSha: OLD_SHA,
      currentShaState: makeCurrentShaState(OLD_SHA, { ciStarted: true }),
    });

    queuePollResponses(ghGet, SHA, [checkRun(1, 'lint')]);

    await source.pollOne('owner/repo/pulls/7', state);

    expect(events).toHaveLength(1);
    expect(events[0]).toContain('(head abcdef1)');
    expect(state.currentShaState?.sha).toBe(SHA);
    expect(state.currentShaState?.ciStarted).toBe(true);
  });
});
