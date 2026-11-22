/**
 * The Git page of the settings body: the GitHub token and the PR, repo and
 * issue subscriptions runs hold.
 */
import { Context, Effect, Option, Result, Schema } from 'effect';

import {
  type AppSignals,
  Secrets,
  ToolCatalog,
} from '@texra-ai/worldline/plugins';
import type { RunId } from '@texra-ai/worldline/schemas';
import { GitHubSubscriptions } from '@texra/tools/github/subscriptionBindings';
import {
  SubscriptionTargetPath,
  targetPath,
} from '@texra/tools/github/subscriptionTarget';
import {
  GITHUB_TOKEN_PROMPT,
  GITHUB_TOKEN_REMOVED_MESSAGE,
  GITHUB_TOKEN_SAVED_MESSAGE,
  removeGitHubToken,
  resolveGitHubTokenSource,
  saveGitHubToken,
} from '@texra/tools/github/githubAuth';

import {
  hostStatePage,
  type SettingsHostBindings,
  type SettingsPresentation,
  type SettingsViewInboundHandlerRegistry,
} from './settingsHostBindings';

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

/** The PR, issue and repository subscriptions, each with the runs that hold
 *  it. */
const subscriptionEntries = (runLabel: (runId: RunId) => string | undefined) =>
  whileUp(
    [],
    Effect.flatMap(GitHubSubscriptions, (subscriptions) =>
      Effect.map(subscriptions.list, (entries) =>
        entries.map((entry) => ({
          key: targetPath(entry.target),
          owners: entry.runIds.map((runId) => ({
            runId,
            label: runLabel(runId) ?? runId,
          })),
        })),
      ),
    ),
  ).pipe(Effect.withSpan('githubSubscriptions.listEntries'));

/**
 * Remove every binding for a subscription key, a target's path. A key that
 * is not one names no subscription.
 */
const unsubscribeKey = (key: string) => {
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

/** The Git page: its handlers and its pages. */
export function settingsGitCommands(ports: {
  readonly bindings: SettingsHostBindings;
  readonly present: SettingsPresentation;
}) {
  const { bindings } = ports;
  const { notice, alert, reported, changed } = ports.present;
  const pages = [
    hostStatePage(
      'githubToken',
      ['github'],
      Effect.map(
        Effect.flatMap(Secrets, resolveGitHubTokenSource),
        (status) => ({
          status,
        }),
      ),
    ),
    hostStatePage(
      'prSubscriptions',
      ['github'],
      Effect.map(subscriptionEntries(bindings.runLabel), (subscriptions) => ({
        subscriptions,
      })),
    ),
  ];

  const handlers = {
    setGitHubToken: Effect.fn('settingsGitCommands.setGitHubToken')(
      function* () {
        const token = yield* bindings.dialogs.input({
          prompt: GITHUB_TOKEN_PROMPT,
          placeholder: 'ghp_…',
          secret: true,
        });
        if (token == null) return;
        yield* reported(
          'Failed to save GitHub token',
          saveGitHubToken(token).pipe(
            Effect.andThen(notice(GITHUB_TOKEN_SAVED_MESSAGE)),
            Effect.andThen(changed('github')),
          ),
        );
      },
    ),
    removeGitHubToken: () =>
      reported(
        'Failed to remove GitHub token',
        removeGitHubToken.pipe(
          Effect.andThen(notice(GITHUB_TOKEN_REMOVED_MESSAGE)),
          Effect.andThen(changed('github')),
        ),
      ),
    unsubscribePR: ({ key }) =>
      Effect.flatMap(unsubscribeKey(key), (removed) =>
        removed === 0
          ? notice(`No active subscription for ${key}.`)
          : changed('github'),
      ),
    // Jump from a subscription to the run that owns it; a run deleted since
    // has nothing to show, so say so instead of leaving the click inert.
    openPRSubscriptionStream: ({ runId }) =>
      Effect.flatMap(
        bindings.revealRun(runId),
        (result) =>
          ({
            revealed: Effect.void,
            missing: notice('This task is no longer available.'),
            unavailable: alert(
              'The Tasks view is not available. Please try again.',
            ),
          })[result],
      ),
  } satisfies Partial<SettingsViewInboundHandlerRegistry>;
  return { handlers, pages };
}
