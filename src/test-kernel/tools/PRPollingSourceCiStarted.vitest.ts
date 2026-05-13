// Third-party imports
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

// Local imports - tools
import type { GhCheckRun, GhPullRequest } from '@tools/github/prTypes';

interface CiStartedState {
  pr: { owner: string; repo: string; pullNumber: number };
  slug: string;
  listeners: Set<(text: string) => void>;
  initialized: boolean;
  seenIssueCommentIds: Set<number>;
  seenReviewCommentIds: Set<number>;
  seenReviewIds: Set<number>;
  lastFailedCheckKeys: Set<string>;
  lastAnnotationKeys: Set<string>;
  pendingAnnotationRuns: GhCheckRun[];
  ciStartedSha: string | undefined;
  ciCompleteSha: string | undefined;
  ciPassedSha: string | undefined;
  headSha: string | undefined;
  state: 'open' | 'closed' | undefined;
  merged: boolean;
  mergeableState: string | undefined;
  etags: {
    pr?: string;
    issueComments?: string;
    reviewComments?: string;
    reviews?: string;
  };
  checkRunsCache?: {
    etagsByPage: Map<number, string>;
    pagesByPage: Map<number, GhCheckRun[]>;
    lastTotalCount: number;
  };
  sinceCursors: {
    issueComments?: string;
    reviewComments?: string;
  };
  lastSuccessAt: number;
  consecutiveFailures: number;
  skipPollUntilMs: number;
}

interface CiStartedSource {
  pollOne(key: string, state: CiStartedState): Promise<void>;
}

const SHA = 'abcdef1234567890';
const OLD_SHA = '1234567890abcdef';

function createState(
  events: string[],
  overrides: Partial<CiStartedState> = {},
): CiStartedState {
  return {
    pr: { owner: 'owner', repo: 'repo', pullNumber: 7 },
    slug: 'owner/repo',
    listeners: new Set([(text) => events.push(text)]),
    initialized: true,
    seenIssueCommentIds: new Set(),
    seenReviewCommentIds: new Set(),
    seenReviewIds: new Set(),
    lastFailedCheckKeys: new Set(),
    lastAnnotationKeys: new Set(),
    pendingAnnotationRuns: [],
    ciStartedSha: undefined,
    ciCompleteSha: undefined,
    ciPassedSha: undefined,
    headSha: SHA,
    state: 'open',
    merged: false,
    mergeableState: 'clean',
    etags: {},
    sinceCursors: {},
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

async function createHarness(): Promise<{
  ghGet: Mock;
  source: CiStartedSource;
}> {
  vi.resetModules();
  const ghGet = vi.fn();
  vi.doMock('@tools/github/githubClient', () => {
    class GitHubAuthError extends Error {}
    class GitHubRateLimitError extends Error {
      constructor(public readonly resetAt: number) {
        super('GitHub rate limit exceeded');
      }
    }
    class GitHubPermanentError extends Error {
      constructor(
        public readonly status: number,
        message: string,
      ) {
        super(message);
      }
    }
    return {
      ghGet,
      GitHubAuthError,
      GitHubRateLimitError,
      GitHubPermanentError,
    };
  });
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
    vi.resetModules();
  });

  it('seeds existing check runs without replaying a CI-started event', async () => {
    const { ghGet, source } = await createHarness();
    const events: string[] = [];
    const state = createState(events, {
      initialized: false,
      headSha: undefined,
      state: undefined,
      ciStartedSha: undefined,
    });

    queuePollResponses(ghGet, SHA, [checkRun(1, 'lint')]);

    await source.pollOne('owner/repo/pulls/7', state);

    expect(events).toEqual([]);
    expect(state.ciStartedSha).toBe(SHA);
  });

  it('emits a CI-started event once when check runs first appear', async () => {
    const { ghGet, source } = await createHarness();
    const events: string[] = [];
    const state = createState(events, { ciStartedSha: undefined });

    queuePollResponses(ghGet, SHA, [checkRun(1, 'lint'), checkRun(2, 'test')]);

    await source.pollOne('owner/repo/pulls/7', state);

    expect(events).toHaveLength(1);
    expect(events[0]).toContain('CI triggered');
    expect(events[0]).toContain('distinct check names');
    expect(events[0]).not.toContain('workflow');
    expect(state.ciStartedSha).toBe(SHA);

    queuePollResponses(ghGet, SHA, [checkRun(1, 'lint'), checkRun(2, 'test')]);

    await source.pollOne('owner/repo/pulls/7', state);

    expect(events).toHaveLength(1);
  });

  it('resets CI-started state on a new head SHA', async () => {
    const { ghGet, source } = await createHarness();
    const events: string[] = [];
    const state = createState(events, {
      headSha: OLD_SHA,
      ciStartedSha: OLD_SHA,
    });

    queuePollResponses(ghGet, SHA, [checkRun(1, 'lint')]);

    await source.pollOne('owner/repo/pulls/7', state);

    expect(events).toHaveLength(1);
    expect(events[0]).toContain('(head abcdef1)');
    expect(state.ciStartedSha).toBe(SHA);
  });
});
