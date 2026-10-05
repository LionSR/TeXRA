// Third-party imports
import { type Context, Effect, Option } from 'effect';

// Local imports - GitHub subscriptions
import type { RunId } from '@shared/schemas';
import { GitHubSubscriptions } from '@texra/tools/github/subscriptionBindings';
import { LiveTools } from '@tools/liveTools';

interface GitHubSubscriptionOwner {
  readonly runId: RunId;
  readonly label: string;
}

interface GitHubSubscriptionEntry {
  readonly key: string;
  readonly owners: GitHubSubscriptionOwner[];
}

/**
 * `read` over the GitHub plugin's subscriptions, which are its process
 * services: `none` once its layer is down (switched off, and no step pins it).
 */
const whileUp = <A>(
  none: A,
  read: Effect.Effect<A, never, GitHubSubscriptions>,
): Effect.Effect<A, never, LiveTools> =>
  Effect.scoped(
    Effect.gen(function* () {
      const services = yield* (yield* LiveTools).processServices(
        'github-pr-subscription',
      );
      return Option.isSome(services)
        ? yield* Effect.provide(
            read,
            // The GitHub plugin's own services, which its layer serves.
            services.value as Context.Context<GitHubSubscriptions>,
          )
        : none;
    }),
  );

/** Builds the shared PR, issue, and repository subscription presentation. */
export const listGitHubSubscriptionEntries = (
  getRunLabel: (runId: RunId) => string | undefined,
) =>
  whileUp(
    [],
    Effect.map(GitHubSubscriptions, (subscriptions) => {
      const toEntry = (binding: {
        key: string;
        runIds: readonly RunId[];
      }): GitHubSubscriptionEntry => ({
        key: binding.key,
        owners: binding.runIds.map((runId) => ({
          runId,
          label: getRunLabel(runId) ?? runId,
        })),
      });
      return [
        ...subscriptions.pr.list().map(toEntry),
        ...subscriptions.repo.list().map(toEntry),
        ...subscriptions.issue.list().map(toEntry),
      ];
    }),
  ).pipe(Effect.withSpan('githubSubscriptions.listEntries'));

/**
 * What both Git tabs say when {@link unsubscribeGitHubKey} matched nothing —
 * the key was already unbound, or never had this shape. The condition is
 * decided here, so the sentence is too.
 */
export function noActiveGitHubSubscriptionMessage(key: string): string {
  return `No active subscription for ${key}.`;
}

/**
 * Removes every binding for a GitHub URL-shaped subscription key.
 * Repo keys are exactly `owner/repo`; a malformed, legacy, or future key
 * shape must not silently default to the repo registry (a destructive unbind),
 * so it is treated as an explicit no-match instead.
 */
export const unsubscribeGitHubKey = (key: string) =>
  whileUp(
    0,
    Effect.map(GitHubSubscriptions, (subscriptions) => {
      if (key.includes('/pulls/')) return subscriptions.pr.unbindAll(key);
      if (key.includes('/issues/')) return subscriptions.issue.unbindAll(key);
      if (/^[^/\s]+\/[^/\s]+$/.test(key)) {
        return subscriptions.repo.unbindAll(key);
      }
      return 0;
    }),
  ).pipe(Effect.withSpan('githubSubscriptions.unsubscribeKey'));
