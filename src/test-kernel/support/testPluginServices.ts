/** The plugin services a test run's steps and a test tool call are served. */
import { Effect, Layer, Scope } from 'effect';

import { Runs } from '@agent/runtime/runRegistry';
import type { PluginContext } from '@platform/processRuntime';
import {
  claudeAgentSessionsLayer,
  codexThreadsLayer,
} from '@texra/tools/agentCliSessionStores';
import { GitHubSubscriptions } from '@texra/tools/github/subscriptionBindings';
import { codeSandboxLayer } from '@tools/codemode/ScriptTool';
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
  codeSandboxLayer,
  codexThreadsLayer,
  claudeAgentSessionsLayer,
  Layer.succeed(GitHubSubscriptions)(unreadGitHubSubscriptions),
).pipe(Layer.provide(Layer.succeed(PluginHold)(noPluginHold)));

/**
 * The plugin services of the session whose `Runs` a call is served, as a
 * step pins them: built once per `Runs` (a session's, or a suite's stand-in)
 * and kept for the test's life, so they outlive the call as a session's
 * do, beside the unread GitHub tables, which are process services.
 */
const builtFor = new WeakMap<object, PluginContext>();
export const testCallPluginServices = Layer.merge(
  Layer.effectContext(
    Effect.flatMap(Runs, (runs) =>
      Effect.suspend(() => {
        const built = builtFor.get(runs);
        if (built !== undefined) return Effect.succeed(built);
        return Layer.build(testPluginServicesLayer).pipe(
          Effect.provideService(Runs, runs),
          Scope.provide(Scope.makeUnsafe()),
          Effect.map((services) => {
            const context = services as PluginContext;
            builtFor.set(runs, context);
            return context;
          }),
        );
      }),
    ),
  ),
  Layer.succeed(GitHubSubscriptions)(unreadGitHubSubscriptions),
);
