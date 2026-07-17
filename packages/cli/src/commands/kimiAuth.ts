import { defineCommand } from 'citty';

import {
  kimiCodeCoordinator,
  setPreferKimiCodeSubscription,
  type KimiCodeSession,
} from '@auth/kimiCode';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';

import {
  kimiCodeSignOutPreferenceMessage,
  signInCliKimiCode,
  signOutCliKimiCode,
} from '../runtime/kimiCodeLogin';
import { CliExitCode } from '../runtime/exitCodes';
import { initCliPlatform } from '../runtime/initPlatform';
import {
  writeErrorStderr,
  writeTextStderr,
  writeTextStdout,
} from '../runtime/logSinks';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { GLOBAL_ARGS } from './_helpers/globalArgs';
import { emitCliResult } from './_helpers/output';
import type { CliContext } from '../runtime/cliContext';

function emitLogin(
  context: CliContext,
  session: KimiCodeSession,
  preferenceEffective: boolean,
): void {
  const payload = {
    authenticated: true,
    accountId: session.accountId ?? null,
    preferSubscription: preferenceEffective,
  };
  const signedIn = 'Signed in with Kimi Code.';
  emitCliResult(context, {
    json: payload,
    ndjson: { kind: 'kimi-code-auth', ...payload },
    text: preferenceEffective
      ? `${signedIn}\nKimi Code subscription enabled for Kimi models.`
      : `${signedIn}\nKimi Code subscription preference could not be enabled because a more specific setting overrides the config.`,
  });
}

const kimiLoginCommand = defineCliCommand({
  meta: {
    name: 'login',
    description: 'Sign in with your Kimi Code membership (device code)',
  },
  args: { ...GLOBAL_ARGS },
  async run(context) {
    await initCliPlatform({ ...context, quietLogs: true });
    const writeProgress =
      context.outputFormat === 'text' ? writeTextStdout : writeTextStderr;

    let session: KimiCodeSession;
    try {
      session = await signInCliKimiCode({ writeProgress });
    } catch (error) {
      writeErrorStderr(error);
      return CliExitCode.ModelOrNetworkError;
    }

    const update = await setPreferKimiCodeSubscription(true);
    emitLogin(context, session, update.effective);
    invalidateModelOptionsCache();
    return CliExitCode.Success;
  },
});

const kimiLogoutCommand = defineCliCommand({
  meta: {
    name: 'logout',
    description: 'Sign out of your Kimi Code membership',
  },
  args: { ...GLOBAL_ARGS },
  async run(context) {
    await initCliPlatform({ ...context, quietLogs: true });
    let update: Awaited<ReturnType<typeof signOutCliKimiCode>>;
    try {
      update = await signOutCliKimiCode();
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
      ndjson: { kind: 'kimi-code-auth', ...payload },
      text: `Signed out of Kimi Code.\n${kimiCodeSignOutPreferenceMessage(update)}`,
    });
    return CliExitCode.Success;
  },
});

const kimiStatusCommand = defineCliCommand({
  meta: {
    name: 'status',
    description: 'Show Kimi Code sign-in status',
  },
  args: { ...GLOBAL_ARGS },
  async run(context) {
    await initCliPlatform({ ...context, quietLogs: true });
    const status = await kimiCodeCoordinator().getStatus();
    emitCliResult(context, {
      json: status,
      ndjson: { kind: 'kimi-code-auth-status', ...status },
      text: status.signedIn
        ? 'Signed in with Kimi Code.'
        : 'Not signed in with Kimi Code.',
    });
    return CliExitCode.Success;
  },
});

const KIMI_SUBCOMMANDS = {
  login: kimiLoginCommand,
  logout: kimiLogoutCommand,
  status: kimiStatusCommand,
} as const;

export const kimiAuthCommand = defineCommand({
  meta: {
    name: 'kimi',
    description:
      'Sign in with your Kimi Code membership to use Kimi models via the coding plan',
  },
  args: { ...GLOBAL_ARGS },
  default: 'status',
  subCommands: KIMI_SUBCOMMANDS,
});
