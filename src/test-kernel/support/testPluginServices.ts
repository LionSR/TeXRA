/** The plugin services a test run's steps and a test tool call are served. */
import { Context, Effect, Layer, Scope } from 'effect';

import {
  Runs,
  type RunRegistry,
  type RunRegistryInit,
} from '@agent/runtime/runRegistry';
import type { PluginServices } from '@platform/processRuntime';
import {
  claudeAgentSessionsLayer,
  codexThreadsLayer,
} from '@tools/agentCliSessionStores';
import { GitHubSubscriptions } from '@tools/github/subscriptionBindings';
import { goalGrantsLayer } from '@tools/goal/goalAutoApproval';
import { PluginHold } from '@tools/toolTable';

/** A test session's services live for the test: a hold holds nothing. */
export const noPluginHold = () => Effect.void;

/**
 * The GitHub plugin's subscription tables, unread. A registry is a live
 * ownership table over a polling source, so the harness serves none: a suite
 * that exercises one provides `gitHubSubscriptionsLayer` innermost, and a
 * read here is a test wiring error rather than an empty answer. Reaching for
 * the real layer instead would load the follow-up module in the support
 * files, ahead of the suites that mock it.
 */
const unreadGitHubSubscriptions = new Proxy(
  {} as GitHubSubscriptions['Service'],
  {
    get: (target, member) => {
      if (member === 'pr' || member === 'repo' || member === 'issue') {
        throw new Error(
          `No GitHub subscriptions in this test: provide gitHubSubscriptionsLayer to read '${member}'.`,
        );
      }
      return Reflect.get(target, member);
    },
  },
);

/** Every plugin's services over the session's `Runs`, as a step pins them. */
export const testPluginServicesLayer = Layer.mergeAll(
  goalGrantsLayer,
  codexThreadsLayer,
  claudeAgentSessionsLayer,
  Layer.succeed(GitHubSubscriptions)(unreadGitHubSubscriptions),
).pipe(Layer.provide(Layer.succeed(PluginHold)(noPluginHold)));

/**
 * The plugin services of the session whose `Runs` a call is served, as a
 * step pins them: the session's own builds, which outlive the call (a goal
 * grant is revoked only when its layer is released), beside the unread
 * GitHub tables, which are process services.
 */
export const testCallPluginServices = Layer.merge(
  Layer.effectContext(
    Effect.flatMap(Runs, (runs) =>
      // A suite's stand-in `Runs` has no session: the call gets its own.
      typeof runs.pinPlugins === 'function'
        ? runs.pinPlugins(new Set(['goal', 'codex', 'claude-agent']))
        : Layer.build(testPluginServicesLayer),
    ),
  ),
  Layer.succeed(GitHubSubscriptions)(unreadGitHubSubscriptions),
);

/**
 * A test session's `pinPlugins`: every plugin's services, built once for
 * the registry `runs` names and kept for the test's life, whatever the step
 * found switched on.
 */
export function testPinPlugins(
  runs: () => RunRegistry,
): RunRegistryInit['pinPlugins'] {
  let built: Context.Context<PluginServices> | undefined;
  return () =>
    Effect.suspend(() =>
      built !== undefined
        ? Effect.succeed(built)
        : Layer.build(testPluginServicesLayer).pipe(
            Effect.provideService(Runs, runs()),
            Scope.provide(Scope.makeUnsafe()),
            Effect.map((services) => {
              built = services as Context.Context<PluginServices>;
              return built;
            }),
          ),
    );
}

/** A registry's `pinPlugins` for a suite that runs no tool: serves nothing. */
export const pinNoPlugins: RunRegistryInit['pinPlugins'] = () =>
  Effect.succeed(Context.empty() as Context.Context<PluginServices>);
