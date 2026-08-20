import { defineCommand, type CommandDef } from 'citty';

import type { CliContext } from '@cli/runtime/cliContext';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { initCliPlatform } from '@cli/runtime/initPlatform';
import {
  shouldUseSubscriptionDeviceCode,
  signInCliSubscription,
  signOutCliSubscription,
  subscriptionSignOutOutcomeMessage,
} from '@cli/runtime/subscriptionLogin';
import {
  subscriptionProvider,
  type SubscriptionAccount,
  type SubscriptionProviderId,
} from '@controllers/modelAccess/subscriptionProviders';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';

import { withCliAuthError } from './cliAuthError';
import { defineCliCommand } from './defineCliCommand';
import { booleanArg, GLOBAL_ARGS } from './globalArgs';
import { cliProgressWriter, emitCliResult } from './output';

export interface DefineSubscriptionAuthCommandOptions {
  readonly providerId: SubscriptionProviderId;
  readonly commandName: string;
  readonly rootDescription: string;
  readonly loginDescription: string;
  readonly logoutDescription: string;
  readonly statusDescription: string;
  /** Registered ndjson discriminator; the status record appends '-status'. */
  readonly ndjsonKind: 'chatgpt-auth' | 'grok-auth';
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
): CommandDef<typeof GLOBAL_ARGS> {
  const provider = subscriptionProvider(options.providerId);

  async function runLogin(
    context: CliContext,
    init: { device: boolean; noBrowser: boolean },
  ): Promise<number> {
    await initCliPlatform({ ...context, quietLogs: true });
    const writeProgress = cliProgressWriter(context);

    const signInResult = await withCliAuthError(() =>
      signInCliSubscription(
        options.providerId,
        { ...init, device: shouldUseSubscriptionDeviceCode(context, init) },
        { writeProgress },
      ),
    );
    if (!signInResult.ok) return CliExitCode.ModelOrNetworkError;

    const update = await provider.setPreferSubscription(true);
    const account = signInResult.value;
    const payload = {
      authenticated: true,
      email: account.email ?? null,
      ...options.loginPayloadExtras?.(account),
      preferSubscription: update.effective,
    };
    const signedIn = `Signed in with ${provider.displayName} as ${account.label}.`;
    emitCliResult(context, {
      json: payload,
      ndjson: { kind: options.ndjsonKind, ...payload },
      text: update.effective
        ? `${signedIn}\n${provider.displayName} subscription enabled for ${provider.modelFamily}.`
        : `${signedIn}\n${provider.displayName} subscription preference could not be enabled because a more specific setting overrides the config.`,
    });
    invalidateModelOptionsCache();
    return CliExitCode.Success;
  }

  const loginCommand = defineCliCommand({
    meta: {
      name: 'login',
      description: options.loginDescription,
    },
    args: {
      ...GLOBAL_ARGS,
      device: {
        type: 'boolean',
        description:
          'Sign in with a one-time device code (for SSH, containers, or any headless shell)',
      },
      'no-browser': {
        type: 'boolean',
        description:
          'Print the loopback sign-in URL instead of opening a browser',
      },
    },
    run: (context, ctx) =>
      runLogin(context, {
        device: ctx.args.device === true,
        noBrowser: booleanArg(ctx.args, 'no-browser'),
      }),
  });

  const logoutCommand = defineCliCommand({
    meta: {
      name: 'logout',
      description: options.logoutDescription,
    },
    args: { ...GLOBAL_ARGS },
    async run(context) {
      await initCliPlatform({ ...context, quietLogs: true });
      const signOutResult = await withCliAuthError(() =>
        signOutCliSubscription(options.providerId),
      );
      if (!signOutResult.ok) return CliExitCode.ModelOrNetworkError;
      const update = signOutResult.value;
      invalidateModelOptionsCache();
      const payload = {
        authenticated: false,
        preferSubscription: update.preferenceUpdate?.effective ?? null,
        ...(update.preferenceError
          ? { preferenceError: update.preferenceError }
          : {}),
      };
      emitCliResult(context, {
        json: payload,
        ndjson: { kind: options.ndjsonKind, ...payload },
        text: subscriptionSignOutOutcomeMessage(options.providerId, update),
      });
      return CliExitCode.Success;
    },
  });

  const statusCommand = defineCliCommand({
    meta: {
      name: 'status',
      description: options.statusDescription,
    },
    args: { ...GLOBAL_ARGS },
    async run(context) {
      await initCliPlatform({ ...context, quietLogs: true });
      const statusResult = await withCliAuthError(() => provider.getStatus());
      if (!statusResult.ok) return CliExitCode.ModelOrNetworkError;
      const { label, ...status } = statusResult.value;
      emitCliResult(context, {
        json: status,
        ndjson: { kind: `${options.ndjsonKind}-status`, ...status },
        text: status.signedIn
          ? `Signed in with ${provider.displayName} as ${label}.`
          : `Not signed in with ${provider.displayName}.`,
      });
      return CliExitCode.Success;
    },
  });

  return defineCommand({
    meta: {
      name: options.commandName,
      description: options.rootDescription,
    },
    args: { ...GLOBAL_ARGS },
    default: 'status',
    subCommands: {
      login: loginCommand,
      logout: logoutCommand,
      status: statusCommand,
    } as const,
  });
}
