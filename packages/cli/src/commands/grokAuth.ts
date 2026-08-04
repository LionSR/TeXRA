import { defineCommand } from 'citty';

import { xaiAccountLabel, xaiCoordinator, type XaiSession } from '@auth/xai';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import { setPreferXaiSubscription } from '@model/xai/xaiPreference';

import {
  grokSignOutPreferenceMessage,
  shouldUseGrokDeviceCode,
  signInCliGrok,
  signOutCliGrok,
} from '../runtime/grokLogin';
import { CliExitCode } from '../runtime/exitCodes';
import { initCliPlatform } from '../runtime/initPlatform';
import { writeErrorStderr } from '../runtime/logSinks';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { booleanArg, GLOBAL_ARGS } from './_helpers/globalArgs';
import { cliProgressWriter, emitCliResult } from './_helpers/output';
import type { CliContext } from '../runtime/cliContext';

function emitLogin(
  context: CliContext,
  session: XaiSession,
  preferenceEffective: boolean,
): void {
  const payload = {
    authenticated: true,
    email: session.email ?? null,
    preferSubscription: preferenceEffective,
  };
  const signedIn = `Signed in with Grok as ${xaiAccountLabel(session)}.`;
  emitCliResult(context, {
    json: payload,
    ndjson: { kind: 'grok-auth', ...payload },
    text: preferenceEffective
      ? `${signedIn}\nGrok subscription enabled for xAI models.`
      : `${signedIn}\nGrok subscription preference could not be enabled because a more specific setting overrides the config.`,
  });
}

async function runGrokLogin(
  context: CliContext,
  init: { device: boolean; noBrowser: boolean },
): Promise<number> {
  await initCliPlatform({ ...context, quietLogs: true });
  const writeProgress = cliProgressWriter(context);

  let session: XaiSession;
  try {
    session = await signInCliGrok(
      {
        ...init,
        device: shouldUseGrokDeviceCode(context, init),
      },
      { writeProgress },
    );
  } catch (error) {
    writeErrorStderr(error);
    return CliExitCode.ModelOrNetworkError;
  }

  const update = await setPreferXaiSubscription(true);
  emitLogin(context, session, update.effective);
  invalidateModelOptionsCache();
  return CliExitCode.Success;
}

const grokLoginCommand = defineCliCommand({
  meta: {
    name: 'login',
    description: 'Sign in with your Grok (xAI SuperGrok) account',
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
    runGrokLogin(context, {
      device: ctx.args.device === true,
      noBrowser: booleanArg(ctx.args, 'no-browser'),
    }),
});

const grokLogoutCommand = defineCliCommand({
  meta: {
    name: 'logout',
    description: 'Sign out of your Grok subscription',
  },
  args: { ...GLOBAL_ARGS },
  async run(context) {
    await initCliPlatform({ ...context, quietLogs: true });
    let update: Awaited<ReturnType<typeof signOutCliGrok>>;
    try {
      update = await signOutCliGrok();
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
      ndjson: { kind: 'grok-auth', ...payload },
      text: `Signed out of Grok.\n${grokSignOutPreferenceMessage(update)}`,
    });
    return CliExitCode.Success;
  },
});

const grokStatusCommand = defineCliCommand({
  meta: {
    name: 'status',
    description: 'Show Grok subscription sign-in status',
  },
  args: { ...GLOBAL_ARGS },
  async run(context) {
    await initCliPlatform({ ...context, quietLogs: true });
    const status = await xaiCoordinator().getStatus();
    emitCliResult(context, {
      json: status,
      ndjson: { kind: 'grok-auth-status', ...status },
      text: status.signedIn
        ? `Signed in with Grok as ${xaiAccountLabel(status)}.`
        : 'Not signed in with Grok.',
    });
    return CliExitCode.Success;
  },
});

const GROK_SUBCOMMANDS = {
  login: grokLoginCommand,
  logout: grokLogoutCommand,
  status: grokStatusCommand,
} as const;

export const grokAuthCommand = defineCommand({
  meta: {
    name: 'grok',
    description:
      'Sign in with your Grok (xAI SuperGrok) account to use xAI models via subscription',
  },
  args: { ...GLOBAL_ARGS },
  default: 'status',
  subCommands: GROK_SUBCOMMANDS,
});
