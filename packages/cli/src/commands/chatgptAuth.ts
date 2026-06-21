import { defineCommand } from 'citty';

import {
  codexCoordinator,
  loginWithDeviceCode,
  loginWithLoopback,
  type CodexSession,
} from '@auth/codex';

import { tryOpenBrowser } from '../runtime/browser';
import { CliExitCode } from '../runtime/exitCodes';
import { initCliPlatform } from '../runtime/initPlatform';
import {
  writeErrorStderr,
  writeTextStderr,
  writeTextStdout,
} from '../runtime/logSinks';
import { interactiveTerminalFailure } from '../runtime/terminalRequirements';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { GLOBAL_ARGS } from './_helpers/globalArgs';
import { emitCliResult } from './_helpers/output';
import type { CliContext } from '../runtime/cliContext';

type ChatgptLoginArgs = Record<string, unknown>;

function readBool(
  args: ChatgptLoginArgs,
  hyphen: string,
  camel: string,
): boolean {
  return args[hyphen] === true || args[camel] === true;
}

/**
 * Device-code is the right default when there's no interactive browser to reach:
 * non-text output, a non-TTY/headless/dumb terminal, or `--no-input`. An
 * explicit `--no-browser` keeps the loopback flow but prints the URL to paste.
 */
function shouldUseDeviceCode(
  context: CliContext,
  deviceFlag: boolean,
  noBrowser: boolean,
): boolean {
  if (deviceFlag) return true;
  if (noBrowser) return false;
  // `interactiveTerminalFailure` already returns a reason for headless mode
  // (which `--no-input` forces), non-TTY stdout, and dumb terminals.
  return (
    context.outputFormat !== 'text' ||
    interactiveTerminalFailure(context) !== undefined
  );
}

function accountLabel(session: CodexSession): string {
  return session.email ?? session.accountId ?? 'your ChatGPT account';
}

function emitLogin(context: CliContext, session: CodexSession): void {
  emitCliResult(context, {
    json: {
      authenticated: true,
      email: session.email ?? null,
      accountId: session.accountId ?? null,
    },
    ndjson: {
      kind: 'chatgpt-auth',
      authenticated: true,
      email: session.email ?? null,
    },
    text: `Signed in with ChatGPT as ${accountLabel(session)}.\nEnable "chatgptCodex.preferSubscription" in your TeXRA config to route Codex models through your subscription.`,
  });
}

async function runChatgptLogin(
  context: CliContext,
  init: { device: boolean; noBrowser: boolean },
): Promise<number> {
  await initCliPlatform({ ...context, quietLogs: true });
  const coordinator = codexCoordinator();
  const writeProgress =
    context.outputFormat === 'text' ? writeTextStdout : writeTextStderr;

  let session: CodexSession;
  try {
    if (shouldUseDeviceCode(context, init.device, init.noBrowser)) {
      session = await loginWithDeviceCode({
        coordinator,
        onPrompt: ({ userCode, verificationUrl }) => {
          writeProgress(
            `To sign in with ChatGPT:\n  1. Open ${verificationUrl}\n  2. Enter the one-time code: ${userCode}\nWaiting for approval… (Ctrl-C cancels)`,
          );
        },
      });
    } else {
      session = await loginWithLoopback({
        coordinator,
        openBrowser: async (url) => {
          if (!init.noBrowser) {
            writeProgress('Opening your browser to sign in with ChatGPT…');
            const opened = await tryOpenBrowser(url);
            if (opened) return;
          }
          writeProgress(`Open this URL to sign in with ChatGPT:\n${url}`);
        },
      });
    }
  } catch (error) {
    writeErrorStderr(error);
    return CliExitCode.ModelOrNetworkError;
  }

  emitLogin(context, session);
  return CliExitCode.Success;
}

const chatgptLoginCommand = defineCliCommand({
  meta: {
    name: 'login',
    description: 'Sign in with your ChatGPT subscription (experimental)',
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
      device: readBool(ctx.args, 'device', 'device'),
      noBrowser: readBool(ctx.args, 'no-browser', 'noBrowser'),
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
    try {
      await codexCoordinator().signOut();
    } catch (error) {
      writeErrorStderr(error);
      return CliExitCode.ModelOrNetworkError;
    }
    emitCliResult(context, {
      json: { authenticated: false },
      ndjson: { kind: 'chatgpt-auth', authenticated: false },
      text: 'Signed out of ChatGPT.',
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

export const CHATGPT_SUBCOMMAND_NAMES = Object.keys(CHATGPT_SUBCOMMANDS);

export const chatgptAuthCommand = defineCommand({
  meta: {
    name: 'chatgpt',
    description:
      'Sign in with your ChatGPT subscription to use Codex models (experimental)',
  },
  args: { ...GLOBAL_ARGS },
  default: 'status',
  subCommands: CHATGPT_SUBCOMMANDS,
});
