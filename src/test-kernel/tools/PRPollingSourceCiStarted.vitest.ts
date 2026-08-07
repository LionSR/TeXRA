// Third-party imports
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

// Local imports - tools
import type { PRSubscriptionState } from '@tools/github/PRPollingSource';
import type { GhCheckRun, GhPullRequest } from '@tools/github/prTypes';

// Local imports - test support
import { mockGitHubClient } from '../support/githubClientMock';
import {
  createPRCurrentShaState,
  createPRSubscriptionState,
} from '../support/prPollingSourceState';

interface CiStartedSource {
  pollOne(key: string, state: PRSubscriptionState): Promise<void>;
}

const SHA = 'abcdef1234567890';
const OLD_SHA = '1234567890abcdef';

function createState(
  events: string[],
  overrides: Partial<PRSubscriptionState> = {},
): PRSubscriptionState {
  const listener = (text: string) => events.push(text);
  return createPRSubscriptionState({
    listeners: new Set([listener]),
    currentShaState: createPRCurrentShaState(SHA),
    state: 'open',
    mergeableState: 'clean',
    ...overrides,
  });
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
    vi.resetModules();
  });

  it('seeds existing check runs without replaying a CI-started event', async () => {
    const { ghGet, source } = await createHarness();
    const events: string[] = [];
    const state = createState(events, {
      initialized: false,
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
    const { ghGet, source } = await createHarness();
    const events: string[] = [];
    const state = createState(events);
    const runs = [checkRun(1, 'lint'), checkRun(2, 'test')];

    queuePollResponses(ghGet, SHA, runs);

    await source.pollOne('owner/repo/pulls/7', state);

    expect(events).toHaveLength(1);
    expect(events[0]).toContain('CI triggered');
    expect(events[0]).toContain('distinct check names');
    expect(events[0]).not.toContain('workflow');
    expect(state.currentShaState?.ciStarted).toBe(true);

    queuePollResponses(ghGet, SHA, runs);

    await source.pollOne('owner/repo/pulls/7', state);

    expect(events).toHaveLength(1);
  });

  it('resets CI-started state on a new head SHA', async () => {
    const { ghGet, source } = await createHarness();
    const events: string[] = [];
    const state = createState(events, {
      currentShaState: createPRCurrentShaState(OLD_SHA, { ciStarted: true }),
    });

    queuePollResponses(ghGet, SHA, [checkRun(1, 'lint')]);

    await source.pollOne('owner/repo/pulls/7', state);

    expect(events).toHaveLength(1);
    expect(events[0]).toContain('(head abcdef1)');
    expect(state.currentShaState?.sha).toBe(SHA);
    expect(state.currentShaState?.ciStarted).toBe(true);
  });
});
