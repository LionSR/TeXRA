import { vi, type Mock } from 'vitest';

/**
 * Register a vi.doMock for '@tools/github/githubClient' with the three error
 * classes that PRPollingSource tests need to exercise, wiring up a caller-
 * supplied ghGet stub as the module's default GET function.
 *
 * Call this after vi.resetModules() and before the dynamic import of the
 * module-under-test.
 */
export function mockGitHubClient(ghGet: Mock): void {
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
  vi.doMock('@tools/github/githubClient', () => ({
    ghGet,
    GitHubAuthError,
    GitHubRateLimitError,
    GitHubPermanentError,
  }));
}
