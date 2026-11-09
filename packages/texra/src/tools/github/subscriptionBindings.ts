import { Context, type Effect } from 'effect';

import type {
  RunInbox,
  ToolError,
  AppSignals,
} from '@texra-ai/harness/plugins';
import type { RunId } from '@texra-ai/harness/schemas';

import type { GitHubCheckAnnotationLevel } from './checkAnnotationLevels';
import type { GitHubServices } from './githubClient';
import type { SubscriptionTarget } from './subscriptionTarget';

/** One subscribed target and the runs bound to it. */
interface SubscribedTarget {
  readonly target: SubscriptionTarget;
  readonly runIds: readonly RunId[];
}

/**
 * The process's GitHub subscriptions: which runs are bound to which target,
 * and the polling fiber of each target, held for the process by
 * `processLayer` rather than by this module. A disposed runtime takes its
 * subscriptions with it instead of carrying a previous process's bindings
 * into the next one.
 *
 * Shared by the github_subscription tool (bind, unbind, list) and the
 * settings UI (list, unbindAll) so both see the same bindings. The layer
 * that builds it is `gitHubSubscriptionsLayer` in `./subscriptionsLayer`:
 * this module stays free of runtime imports so naming the service costs
 * nothing.
 */
export class GitHubSubscriptions extends Context.Service<
  GitHubSubscriptions,
  {
    /**
     * Bind `runId` to `target`: its events are sent to `inbox`, check
     * annotations from `minAnnotationLevel` up. The first run bound starts
     * the target's polling, within the cap for its kind. Answers false when
     * the run was already bound, whose inbox and level this replaces. The
     * binding ends when the inbox closes.
     */
    readonly bind: (
      runId: RunId,
      target: SubscriptionTarget,
      inbox: RunInbox,
      minAnnotationLevel: GitHubCheckAnnotationLevel,
    ) => Effect.Effect<boolean, ToolError, GitHubServices | AppSignals>;
    /** Unbind `runId` from `target`; false when it was not bound. The last
     *  run's unbind stops the target's polling. */
    readonly unbind: (
      runId: RunId,
      target: SubscriptionTarget,
    ) => Effect.Effect<boolean, never, AppSignals>;
    /** Unbind every run from `target`, answering how many were bound: the
     *  settings UI cancels a subscription without knowing its runs. */
    readonly unbindAll: (
      target: SubscriptionTarget,
    ) => Effect.Effect<number, never, AppSignals>;
    readonly list: Effect.Effect<readonly SubscribedTarget[]>;
    /** Stop every target polling and drain the deliveries already made,
     *  within the close budget: what a process shutdown runs before it
     *  closes the sessions those deliveries reach. */
    readonly drainDeliveries: Effect.Effect<void>;
  }
>()('@texra-ai/texra/tools/GitHubSubscriptions') {}
