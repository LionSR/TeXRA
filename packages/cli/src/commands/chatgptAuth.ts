import { defineCommand } from 'citty';

import { codexCoordinator, type CodexSession } from '@auth/codex';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import { setPreferCodexSubscription } from '@model/codex/codexPreference';

import {
  chatGptAccountLabel,
  chatGptSignOutPreferenceMessage,
  shouldUseChatGptDeviceCode,
  signInCliChatGpt,
  signOutCliChatGpt,
} from '../runtime/chatgptLogin';
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
  session: CodexSession,
  preferenceEffective: boolean,
): void {
  const payload = {
    authenticated: true,
    email: session.email ?? null,
    accountId: session.accountId ?? null,
    preferSubscription: preferenceEffective,
  };
  const signedIn = `Signed in with ChatGPT as ${chatGptAccountLabel(session)}.`;
  emitCliResult(context, {
    json: payload,
    ndjson: { kind: 'chatgpt-auth', ...payload },
    text: preferenceEffective
      ? `${signedIn}\nChatGPT subscription enabled for Codex models.`
      : `${signedIn}\nChatGPT subscription preference could not be enabled because a more specific setting overrides the config.`,
  });
}

async function runChatgptLogin(
  context: CliContext,
  init: { device: boolean; noBrowser: boolean },
): Promise<number> {
  await initCliPlatform({ ...context, quietLogs: true });
  const writeProgress =
    context.outputFormat === 'text' ? writeTextStdout : writeTextStderr;

  let session: CodexSession;
  try {
    session = await signInCliChatGpt(
      {
        ...init,
        device: shouldUseChatGptDeviceCode(context, init),
      },
      { writeProgress },
    );
  } catch (error) {
    writeErrorStderr(error);
    return CliExitCode.ModelOrNetworkError;
  }

  const update = await setPreferCodexSubscription(true);
  emitLogin(context, session, update.effective);
  invalidateModelOptionsCache();
  return CliExitCode.Success;
}

const chatgptLoginCommand = defineCliCommand({
  meta: {
    name: 'login',
    description: 'Sign in with your ChatGPT subscription',
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
    runChatgptLogin(context, {
      device: ctx.args.device === true,
      noBrowser:
        ctx.args['no-browser'] === true ||
        ctx.args.noBrowser === true ||
        ctx.args.browser === false,
    }),
});

const chatgptLogoutCommand = defineCliCommand({
  meta: {
    name: 'logout',
    description: 'Sign out of your ChatGPT subscription',
  },
  args: { ...GLOBAL_ARGS },
  async run(context) {
    await initCliPlatform({ ...context, quietLogs: true });
    let update: Awaited<ReturnType<typeof signOutCliChatGpt>>;
    try {
      update = await signOutCliChatGpt();
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
      ndjson: { kind: 'chatgpt-auth', ...payload },
      text: `Signed out of ChatGPT.\n${chatGptSignOutPreferenceMessage(update)}`,
    });
    return CliExitCode.Success;
  },
});

const chatgptStatusCommand = defineCliCommand({
  meta: {
    name: 'status',
    description: 'Show ChatGPT subscription sign-in status',
  },
  args: { ...GLOBAL_ARGS },
  async run(context) {
    await initCliPlatform({ ...context, quietLogs: true });
    const status = await codexCoordinator().getStatus();
    emitCliResult(context, {
      json: status,
      ndjson: { kind: 'chatgpt-auth-status', ...status },
      text: status.signedIn
        ? `Signed in with ChatGPT as ${status.email ?? status.accountId ?? 'unknown'}.`
        : 'Not signed in with ChatGPT.',
    });
    return CliExitCode.Success;
  },
});

const CHATGPT_SUBCOMMANDS = {
  login: chatgptLoginCommand,
  logout: chatgptLogoutCommand,
  status: chatgptStatusCommand,
} as const;

export const chatgptAuthCommand = defineCommand({
  meta: {
    name: 'chatgpt',
    description: 'Sign in with your ChatGPT subscription to use Codex models',
  },
  args: { ...GLOBAL_ARGS },
  default: 'status',
  subCommands: CHATGPT_SUBCOMMANDS,
});
