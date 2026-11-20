import { Cause, Effect } from 'effect';
import { Command } from 'effect/cli';

import { CliInvocation } from '@cli/runtime/platform/cliContext';
import { CliExitCode } from '@cli/runtime/platform/exitCodes';
import { cliPlatform } from '@cli/runtime/platform/initPlatform';
import { writeErrorStderr } from '@cli/runtime/platform/logSinks';
import {
  shouldUseSubscriptionDeviceCode,
  signInCliSubscription,
  signOutCliSubscription,
  subscriptionSignOutOutcomeMessage,
} from '@cli/runtime/models/subscriptionLogin';
import {
  subscriptionProvider,
  type SubscriptionAccount,
  type SubscriptionProviderId,
} from '@texra/controllers/modelAccess/subscriptionProviders';
import { ACCOUNT_OUTCOME } from '@ui/copy/accountAuth';

import { cliCommand } from './cliCommand';
import { boolFlag } from './flags';
import { cliProgressWriter, emitCliResult } from './output';

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
  readonly rootDescription: string;
  readonly loginDescription: string;
  readonly logoutDescription: string;
  readonly statusDescription: string;
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
 * its runtime bindings and user-facing nouns; the control flow, output
 * payloads, and exit codes live here exactly once.
 */
export function defineSubscriptionAuthCommand(
  options: DefineSubscriptionAuthCommandOptions,
) {
  const provider = subscriptionProvider(options.providerId);
  /** Registered ndjson discriminator; the status record appends '-status'. */
  const ndjsonKind = `${options.providerId}-auth` as const;

  function runLogin(init: { device: boolean; noBrowser: boolean }) {
    return Effect.gen(function* () {
      const { context } = yield* CliInvocation;
      const writeProgress = yield* cliProgressWriter;
      const services = yield* cliPlatform;
      const signInResult = yield* withCliAuthError(
        signInCliSubscription(
          services,
          options.providerId,
          { ...init, device: shouldUseSubscriptionDeviceCode(context, init) },
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
    description: options.loginDescription,
    config: {
      device: boolFlag(
        'device',
        'For SSH, containers, or any headless shell: sign in with a one-time device code where the provider has one, otherwise print the browser sign-in URL',
      ),
      noBrowser: boolFlag(
        'no-browser',
        'Print the loopback sign-in URL instead of opening a browser',
      ),
    },
    run: (_, input) => runLogin(input),
  });

  const logoutCommand = cliCommand('logout', {
    description: options.logoutDescription,
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
    description: options.rootDescription,
    ...status,
  }).pipe(
    Command.withSubcommands([
      loginCommand,
      logoutCommand,
      cliCommand('status', {
        description: options.statusDescription,
        ...status,
      }),
    ]),
  );
}
