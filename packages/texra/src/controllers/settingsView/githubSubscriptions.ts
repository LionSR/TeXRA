// Third-party imports
import { Context, Effect, Option, Result, Schema } from 'effect';

// Local imports - GitHub subscriptions
import { ToolCatalog, type AppSignals } from '@texra-ai/harness/host';
import { GitHubSubscriptions } from '@texra/tools/github/subscriptionBindings';
import {
  SubscriptionTargetPath,
  targetPath,
} from '@texra/tools/github/subscriptionTarget';
import type { RunId } from '@texra-ai/harness/schemas';

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
  read: Effect.Effect<A, never, GitHubSubscriptions | AppSignals>,
): Effect.Effect<A, never, ToolCatalog | AppSignals> =>
  Effect.scoped(
    Effect.gen(function* () {
      const services = yield* (yield* ToolCatalog).processServices(
        'github-pr-subscription',
      );
      return Option.isSome(services)
        ? yield* Effect.provideService(
            read,
            GitHubSubscriptions,
            // The GitHub plugin's own service, which its layer serves.
            Context.getUnsafe(services.value, GitHubSubscriptions),
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
    Effect.flatMap(GitHubSubscriptions, (subscriptions) =>
      Effect.map(subscriptions.list, (entries) =>
        entries.map((entry): GitHubSubscriptionEntry => ({
          key: targetPath(entry.target),
          owners: entry.runIds.map((runId) => ({
            runId,
            label: getRunLabel(runId) ?? runId,
          })),
        })),
      ),
    ),
  ).pipe(Effect.withSpan('githubSubscriptions.listEntries'));

/**
 * Removes every binding for a subscription key, a target's path. A key that
 * is not one names no subscription.
 */
export const unsubscribeGitHubKey = (key: string) => {
  const target = Schema.decodeUnknownResult(SubscriptionTargetPath)(key);
  return whileUp(
    0,
    Result.isSuccess(target)
      ? Effect.flatMap(GitHubSubscriptions, (subscriptions) =>
          subscriptions.unbindAll(target.success),
        )
      : Effect.succeed(0),
  ).pipe(Effect.withSpan('githubSubscriptions.unsubscribeKey'));
};
