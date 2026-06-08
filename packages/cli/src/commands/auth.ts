import { defineCommand } from 'citty';

import type { SupabaseSession } from '@auth/SupabaseSession';

import { CliExitCode } from '../runtime/exitCodes';
import { initCliPlatform } from '../runtime/initPlatform';
import {
  githubSelectAccountWarning,
  isCliLoginProvider,
  resolveLoginProvider,
  unsupportedLoginProviderMessage,
  type CliLoginInit,
} from '../runtime/loginOptions';
import {
  writeErrorStderr,
  writeTextStderr,
  writeTextStdout,
} from '../runtime/logSinks';
import {
  fetchRelayUsageSummary,
  parseUtcMonth,
  type RelayUsageSummary,
} from '../runtime/relayUsage';
import { CLI_OAUTH_PROVIDER_INPUTS } from '../runtime/oauthProviderDisplay';
import {
  formatCliManualAuthUrlMessage,
  getCliAuthProfile,
  signInCliSupabase,
  signOutCliSupabase,
  type CliAuthProfile,
} from '../runtime/supabaseAuth';
import { interactiveTerminalFailure } from '../runtime/terminalRequirements';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { GLOBAL_ARGS, optString } from './_helpers/globalArgs';
import { emitCliResult } from './_helpers/output';
import type { CliContext } from '../runtime/cliContext';

type LoginCommandArgs = Record<string, unknown>;

function readBooleanArg(
  args: LoginCommandArgs,
  hyphenKey: string,
  camelKey: string,
): boolean {
  return args[hyphenKey] === true || args[camelKey] === true;
}

function readStringArg(
  args: LoginCommandArgs,
  hyphenKey: string,
  camelKey: string,
): string | undefined {
  return optString(args[hyphenKey]) ?? optString(args[camelKey]);
}

export function loginInitFromArgs(args: LoginCommandArgs): CliLoginInit {
  const positional = optString(args.providerArg);
  const flag = optString(args.provider);
  const provider = resolveLoginProvider(positional, flag);
  return {
    provider: provider.provider,
    providerExplicit: provider.explicit,
    noBrowser:
      readBooleanArg(args, 'no-browser', 'noBrowser') || args.browser === false,
    selectAccount: readBooleanArg(args, 'select-account', 'selectAccount'),
    loginHint: readStringArg(args, 'login-hint', 'loginHint'),
  };
}

export function shouldPromptForLoginProvider(
  context: Pick<
    CliContext,
    'mode' | 'outputFormat' | 'stdoutIsTty' | 'termIsDumb'
  >,
  init: Pick<CliLoginInit, 'providerExplicit' | 'noBrowser'>,
): boolean {
  return (
    !init.providerExplicit &&
    !init.noBrowser &&
    context.outputFormat === 'text' &&
    interactiveTerminalFailure(context) === undefined
  );
}

async function runLogin(
  context: CliContext,
  init: CliLoginInit,
): Promise<number> {
  if (!isCliLoginProvider(init.provider)) {
    writeTextStderr(unsupportedLoginProviderMessage(init.provider));
    return CliExitCode.Usage;
  }
  await initCliPlatform({ ...context, quietLogs: true });
  const accountWarning = githubSelectAccountWarning(init);
  if (accountWarning) writeTextStderr(accountWarning);
  if (context.outputFormat === 'text' && !init.noBrowser) {
    writeTextStdout(`Opening browser for TeXRA ${init.provider} sign-in...`);
  }
  let session: SupabaseSession;
  try {
    session = await signInCliSupabase({
      provider: init.provider,
      openBrowser: !init.noBrowser,
      selectAccount: init.selectAccount,
      loginHint: init.loginHint,
      manualBrowserHint: 'texra login --no-browser',
      onAuthUrl: (url) => {
        if (init.noBrowser) {
          const writeAuthUrl =
            context.outputFormat === 'text' ? writeTextStdout : writeTextStderr;
          writeAuthUrl(formatCliManualAuthUrlMessage(url));
        }
      },
    });
  } catch (error) {
    writeErrorStderr(error);
    return CliExitCode.ModelOrNetworkError;
  }

  const expiresAt = new Date(session.expiresAt).toISOString();
  emitCliResult(context, {
    json: { authenticated: true, account: session.account, expiresAt },
    ndjson: {
      kind: 'auth',
      authenticated: true,
      account: session.account,
      expiresAt,
    },
    text: `Signed in as ${session.account.label}.`,
  });
  return CliExitCode.Success;
}

export const loginCommand = defineCliCommand({
  meta: { name: 'login', description: 'Sign in to TeXRA for included access' },
  args: {
    ...GLOBAL_ARGS,
    provider: {
      type: 'string',
      description: `OAuth provider: ${CLI_OAUTH_PROVIDER_INPUTS} (alternative to positional)`,
    },
    providerArg: {
      type: 'positional',
      required: false,
      description: `OAuth provider: ${CLI_OAUTH_PROVIDER_INPUTS}`,
    },
    'no-browser': {
      type: 'boolean',
      description:
        'Print the loopback sign-in URL instead of opening a browser',
    },
    'select-account': {
      type: 'boolean',
      description:
        'Ask the OAuth provider to show account selection when supported',
    },
    'login-hint': {
      type: 'string',
      description:
        'Suggest a specific provider account, such as a GitHub username or Google email',
    },
  },
  run: (context, ctx) => {
    return runLoginCommand(context, loginInitFromArgs(ctx.args));
  },
});

async function runLoginCommand(
  context: CliContext,
  init: CliLoginInit,
): Promise<number> {
  if (!shouldPromptForLoginProvider(context, init)) {
    return runLogin(context, init);
  }

  const { promptForLoginProvider } = await import('./loginProviderPicker');
  const provider = await promptForLoginProvider(
    context.stdoutColorEnabled ?? context.colorEnabled,
  );
  if (!provider) {
    writeTextStderr('Cancelled. No sign-in started.');
    return CliExitCode.Success;
  }
  return runLogin(context, { ...init, provider, providerExplicit: true });
}

export const logoutCommand = defineCliCommand({
  meta: { name: 'logout', description: 'Sign out of TeXRA' },
  args: {
    ...GLOBAL_ARGS,
  },
  async run(context) {
    await initCliPlatform({ ...context, quietLogs: true });
    try {
      await signOutCliSupabase();
    } catch (error) {
      writeErrorStderr(error);
      return CliExitCode.ModelOrNetworkError;
    }

    emitCliResult(context, {
      json: { authenticated: false },
      ndjson: { kind: 'auth', authenticated: false },
      text: 'Signed out.',
    });
    return CliExitCode.Success;
  },
});

const authStatusCommand = defineCliCommand({
  meta: { name: 'status', description: 'Show TeXRA sign-in status' },
  args: {
    ...GLOBAL_ARGS,
  },
  async run(context) {
    let profile: CliAuthProfile;
    try {
      await initCliPlatform({ ...context, quietLogs: true });
      profile = await getCliAuthProfile();
    } catch (error) {
      writeErrorStderr(error);
      return CliExitCode.ModelOrNetworkError;
    }

    emitCliResult(context, {
      json: profile,
      ndjson: { kind: 'auth-status', ...profile },
      text: profile.authenticated
        ? `Signed in as ${profile.accountLabel || 'unknown'} (${profile.tier ?? 'unknown'}).`
        : 'Not signed in.',
    });
    return CliExitCode.Success;
  },
});

const usageCommand = defineCliCommand({
  meta: { name: 'usage', description: 'Show relay usage for this account' },
  args: {
    ...GLOBAL_ARGS,
    month: {
      type: 'string',
      description: 'UTC month to show, formatted as YYYY-MM',
    },
  },
  async run(context, ctx) {
    const month = optString(ctx.args.month);
    // Pre-validate `--month` before any network I/O so a malformed value
    // yields a Usage error (exit 2), not the catch-all ModelOrNetworkError
    // (exit 3) that the broader try/catch below would assign.
    if (month) {
      try {
        parseUtcMonth(month);
      } catch (error) {
        writeErrorStderr(error);
        return CliExitCode.Usage;
      }
    }
    let summary: RelayUsageSummary;
    try {
      await initCliPlatform({ ...context, quietLogs: true });
      const profile = await getCliAuthProfile();
      if (!profile.authenticated) {
        writeTextStderr('Not signed in. Run `texra login` first.');
        return CliExitCode.ModelOrNetworkError;
      }
      summary = await fetchRelayUsageSummary({
        tier: profile.tier ?? 'free',
        month,
      });
    } catch (error) {
      writeErrorStderr(error);
      return CliExitCode.ModelOrNetworkError;
    }

    const periodMonth = summary.periodStart.slice(0, 7);
    emitCliResult(context, {
      json: summary,
      ndjson: { kind: 'relay-usage', ...summary },
      text: [
        `Relay usage for ${periodMonth} (${summary.tier})`,
        `Spend: $${summary.costUsd.toFixed(2)} / $${summary.limitUsd.toFixed(2)} (${summary.usagePercent.toFixed(1)}%)`,
        `Remaining: $${summary.remainingUsd.toFixed(2)}`,
        `Streams: ${summary.streamCount}`,
        `Tokens: ${summary.inputTokens} input (${summary.cachedTokens} cached), ${summary.outputTokens} output, ${summary.reasoningTokens} reasoning`,
        `Models: ${summary.modelsUsed}; providers: ${summary.providersUsed}`,
      ].join('\n'),
    });
    return CliExitCode.Success;
  },
});

const AUTH_SUBCOMMANDS = {
  login: loginCommand,
  logout: logoutCommand,
  status: authStatusCommand,
  usage: usageCommand,
} as const;

export const AUTH_SUBCOMMAND_NAMES = Object.keys(AUTH_SUBCOMMANDS);

export const authCommand = defineCommand({
  meta: {
    name: 'auth',
    description: 'Sign in, sign out, and check TeXRA account status and usage',
  },
  args: {
    ...GLOBAL_ARGS,
  },
  // Canonical home for every auth verb. `login`/`logout` are also exposed as
  // top-level shortcuts in root.ts (a common CLI convention); everything else
  // lives only here so there is one predictable place to look. Bare `texra
  // auth` is the same status query as `texra auth status`, which keeps global
  // flags like `--no-color` and `--output-format json` usable on the obvious
  // command.
  default: 'status',
  subCommands: AUTH_SUBCOMMANDS,
});
