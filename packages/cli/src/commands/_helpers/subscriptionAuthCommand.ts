import { defineCommand, type CommandDef } from 'citty';

import type { CliContext } from '@cli/runtime/cliContext';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { initCliPlatform } from '@cli/runtime/initPlatform';
import { writeErrorStderr } from '@cli/runtime/logSinks';
import {
  shouldUseSubscriptionDeviceCode,
  type CliSubscriptionLoginTransportInit,
  type CliSubscriptionSignOutResult,
} from '@cli/runtime/subscriptionLogin';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';

import { defineCliCommand } from './defineCliCommand';
import { booleanArg, GLOBAL_ARGS } from './globalArgs';
import { cliProgressWriter, emitCliResult } from './output';

/** Session fields the login payload reads; providers may carry more. */
interface SubscriptionAuthSession {
  readonly email?: string;
}

/** Coordinator status shape both subscription providers report. */
interface SubscriptionAuthStatus {
  readonly signedIn: boolean;
  readonly email?: string;
  readonly accountId?: string;
}

type SubscriptionAccountLabel = (
  account:
    | {
        readonly email?: string | null;
        readonly accountId?: string | null;
      }
    | null
    | undefined,
) => string;

export interface DefineSubscriptionAuthCommandOptions<
  Session extends SubscriptionAuthSession,
> {
  readonly commandName: string;
  readonly displayName: string;
  readonly rootDescription: string;
  readonly loginDescription: string;
  readonly logoutDescription: string;
  readonly statusDescription: string;
  /** Models the subscription unlocks, e.g. 'Codex models'. */
  readonly enabledFor: string;
  /** Registered ndjson discriminator; the status record appends '-status'. */
  readonly ndjsonKind: 'chatgpt-auth' | 'grok-auth';
  readonly accountLabel: SubscriptionAccountLabel;
  /**
   * Provider-specific login payload fields (Codex carries `accountId`; Grok
   * does not). Kept as explicit configuration so the difference stays visible
   * instead of drifting inside two copied payload builders.
   */
  readonly loginPayloadExtras?: (session: Session) => Record<string, unknown>;
  readonly signIn: (
    init: CliSubscriptionLoginTransportInit,
    options: { readonly writeProgress: (message: string) => void },
  ) => Promise<Session>;
  readonly signOut: () => Promise<CliSubscriptionSignOutResult>;
  /**
   * Full sign-out outcome text (`Signed out of …` plus the preference
   * caveat), owned by the provider's runtime login module so the launcher
   * account action reports the same lines.
   */
  readonly signOutOutcomeMessage: (
    result: CliSubscriptionSignOutResult,
  ) => string;
  readonly setPreferSubscription: (
    enabled: boolean,
  ) => Promise<{ readonly effective: boolean }>;
  readonly getStatus: () => Promise<SubscriptionAuthStatus>;
}

/**
 * The shared skeleton of the `<provider> login|logout|status` command group
 * for subscription OAuth providers (ChatGPT, Grok). Each provider supplies
 * its runtime bindings and user-facing nouns; the control flow, output
 * payloads, and exit codes live here exactly once.
 */
export function defineSubscriptionAuthCommand<
  Session extends SubscriptionAuthSession,
>(
  options: DefineSubscriptionAuthCommandOptions<Session>,
): CommandDef<typeof GLOBAL_ARGS> {
  function emitLogin(
    context: CliContext,
    session: Session,
    preferenceEffective: boolean,
  ): void {
    const payload = {
      authenticated: true,
      email: session.email ?? null,
      ...options.loginPayloadExtras?.(session),
      preferSubscription: preferenceEffective,
    };
    const signedIn = `Signed in with ${options.displayName} as ${options.accountLabel(session)}.`;
    emitCliResult(context, {
      json: payload,
      ndjson: { kind: options.ndjsonKind, ...payload },
      text: preferenceEffective
        ? `${signedIn}\n${options.displayName} subscription enabled for ${options.enabledFor}.`
        : `${signedIn}\n${options.displayName} subscription preference could not be enabled because a more specific setting overrides the config.`,
    });
  }

  async function runLogin(
    context: CliContext,
    init: { device: boolean; noBrowser: boolean },
  ): Promise<number> {
    await initCliPlatform({ ...context, quietLogs: true });
    const writeProgress = cliProgressWriter(context);

    let session: Session;
    try {
      session = await options.signIn(
        {
          ...init,
          device: shouldUseSubscriptionDeviceCode(context, init),
        },
        { writeProgress },
      );
    } catch (error) {
      writeErrorStderr(error);
      return CliExitCode.ModelOrNetworkError;
    }

    const update = await options.setPreferSubscription(true);
    emitLogin(context, session, update.effective);
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
      let update: CliSubscriptionSignOutResult;
      try {
        update = await options.signOut();
      } catch (error) {
        writeErrorStderr(error);
        return CliExitCode.ModelOrNetworkError;
      }
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
        text: options.signOutOutcomeMessage(update),
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
      const status = await options.getStatus();
      emitCliResult(context, {
        json: status,
        ndjson: { kind: `${options.ndjsonKind}-status`, ...status },
        text: status.signedIn
          ? `Signed in with ${options.displayName} as ${options.accountLabel(status)}.`
          : `Not signed in with ${options.displayName}.`,
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
