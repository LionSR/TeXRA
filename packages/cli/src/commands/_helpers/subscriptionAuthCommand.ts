import { Cause, Effect } from 'effect';
import { Command } from 'effect/cli';

import { CliInvocation } from '@cli/runtime/platform/cliContext';
import { CliExitCode } from '@cli/runtime/platform/exitCodes';
import { cliPlatform } from '@cli/runtime/platform/initPlatform';
import { writeErrorStderr } from '@cli/runtime/platform/logSinks';
import { cliProgressWriter, emitCliResult } from '@cli/runtime/platform/output';
import {
  resolveLoginTransport,
  signInCliSubscription,
  signOutCliSubscription,
  subscriptionSignOutOutcomeMessage,
} from '@cli/runtime/models/subscriptionLogin';
import type { LoginTransport } from '@cli/runtime/models/loginOptions';
import {
  subscriptionProvider,
  type SubscriptionAccount,
  type SubscriptionProviderId,
} from '@texra/controllers/modelAccess/subscriptionProviders';
import { ACCOUNT_OUTCOME, SUBSCRIPTION_AUTH_COPY } from '@ui/copy/accountAuth';

import { boolFlag, cliCommand } from './cliCommand';

/**
 * Turn one network/auth call into a result the caller narrows with one
 * `if (!result.ok) return CliExitCode.ModelOrNetworkError;` line; a failure
 * (typed or defect) is already written to stderr. Scoped to just the call, so
 * success-path code such as payload emission still runs.
 */
const withCliAuthError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.matchCause({
      onFailure: (cause) => {
        writeErrorStderr(Cause.squash(cause));
        return { ok: false as const };
      },
      onSuccess: (value) => ({ ok: true as const, value }),
    }),
  );

interface DefineSubscriptionAuthCommandOptions {
  readonly providerId: SubscriptionProviderId;
  /**
   * Provider-specific login payload fields (Codex carries `accountId`; Grok
   * does not). Kept as explicit configuration so the difference stays visible
   * instead of drifting inside two copied payload builders.
   */
  readonly loginPayloadExtras?: (
    account: SubscriptionAccount,
  ) => Record<string, unknown>;
}

/**
 * The shared skeleton of the `<provider> login|logout|status` command group
 * for subscription OAuth providers (ChatGPT, Grok). Each provider supplies
 * its runtime bindings; its help text is the account copy every host shows
 * (`SUBSCRIPTION_AUTH_COPY`), and the control flow, output payloads, and
 * exit codes live here exactly once.
 */
export function defineSubscriptionAuthCommand(
  options: DefineSubscriptionAuthCommandOptions,
) {
  const provider = subscriptionProvider(options.providerId);
  const copy = SUBSCRIPTION_AUTH_COPY[options.providerId];
  /** Registered ndjson discriminator; the status record appends '-status'. */
  const ndjsonKind = `${options.providerId}-auth` as const;

  function runLogin(requested: LoginTransport) {
    return Effect.gen(function* () {
      const { context } = yield* CliInvocation;
      const writeProgress = yield* cliProgressWriter;
      const services = yield* cliPlatform;
      const signInResult = yield* withCliAuthError(
        signInCliSubscription(
          services,
          options.providerId,
          resolveLoginTransport(context, requested),
          { writeProgress },
        ),
      );
      if (!signInResult.ok) return CliExitCode.ModelOrNetworkError;

      const account = signInResult.value;
      const payload = {
        authenticated: true,
        email: account.email ?? null,
        ...options.loginPayloadExtras?.(account),
        preferSubscription: true,
      };
      yield* emitCliResult({
        json: payload,
        ndjson: { kind: ndjsonKind, ...payload },
        text: ACCOUNT_OUTCOME.signedInEnabled(
          provider.displayName,
          account.label,
          provider.modelFamily,
        ),
      });
    });
  }

  const loginCommand = cliCommand('login', {
    description: copy.signInLabel,
    config: {
      device: boolFlag(
        'device',
        'Sign in with a one-time code (best for SSH or headless shells)',
      ),
      noBrowser: boolFlag(
        'no-browser',
        'Print the loopback sign-in URL instead of opening a browser',
      ),
    },
    // `--device` wins when both are given.
    run: (_, { device, noBrowser }) =>
      runLogin(device ? 'device' : noBrowser ? 'no-browser' : 'auto'),
  });

  const logoutCommand = cliCommand('logout', {
    description: copy.signOutLabel,
    config: {},
    run: Effect.fn('subscriptionAuthCommand.run')(function* () {
      const services = yield* cliPlatform;
      const signOutResult = yield* withCliAuthError(
        signOutCliSubscription(services, options.providerId),
      );
      if (!signOutResult.ok) return CliExitCode.ModelOrNetworkError;
      const update = signOutResult.value;
      const payload = {
        authenticated: false,
        preferSubscription: update.preferenceError ? null : false,
        ...(update.preferenceError
          ? { preferenceError: update.preferenceError }
          : {}),
      };
      yield* emitCliResult({
        json: payload,
        ndjson: { kind: ndjsonKind, ...payload },
        text: subscriptionSignOutOutcomeMessage(options.providerId, update),
      });
    }),
  });

  const status = {
    config: {},
    run: Effect.fn('subscriptionAuthCommand.run')(function* () {
      yield* cliPlatform;
      const statusResult = yield* withCliAuthError(provider.getStatus());
      if (!statusResult.ok) return CliExitCode.ModelOrNetworkError;
      const { label, ...status } = statusResult.value;
      yield* emitCliResult({
        json: status,
        ndjson: { kind: `${ndjsonKind}-status`, ...status },
        text: status.signedIn
          ? ACCOUNT_OUTCOME.signedInAs(provider.displayName, label)
          : ACCOUNT_OUTCOME.notSignedIn(provider.displayName),
      });
    }),
  };

  // A bare `texra auth <provider>` is its `status`.
  return cliCommand(options.providerId, {
    description: `${copy.signInLabel} to use ${provider.modelFamily}`,
    ...status,
  }).pipe(
    Command.withSubcommands([
      loginCommand,
      logoutCommand,
      cliCommand('status', {
        description: `Show ${copy.subscriptionLabel} sign-in status`,
        ...status,
      }),
    ]),
  );
}
