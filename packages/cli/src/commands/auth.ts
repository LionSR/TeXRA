import { defineCommand } from 'citty';

import { DEFAULT_OAUTH_PROVIDER, isOAuthProvider } from '@auth/config';
import type { SupabaseSession } from '@auth/SupabaseSession';
import { INCLUDED_ACCESS } from '@shared/copy/modelAccess';
import { isNonEmptyString } from '@utils/text/stringUtils';

import { CliExitCode } from '../runtime/exitCodes';
import { initCliPlatform } from '../runtime/initPlatform';
import {
  githubSelectAccountWarning,
  hasLoginTransportConflict,
  LOGIN_TRANSPORT_CONFLICT_MESSAGE,
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
  getCliSessionAccessToken,
  relayTokenStillActiveNotice,
  resolveCliUsageTier,
  signInCliSupabase,
  signInCliSupabaseDeviceCode,
  signOutCliSupabase,
  supabaseSignOutOutcomeMessage,
  type CliAuthProfile,
} from '../runtime/supabaseAuth';
import { formatCliDeviceAuthMessage } from '../runtime/supabaseAuthDeviceCode';
import { interactiveTerminalFailure } from '../runtime/terminalRequirements';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { withUsageSections } from './_helpers/dispatch';
import { booleanArg, GLOBAL_ARGS, optString } from './_helpers/globalArgs';
import { cliProgressWriter, emitCliResult } from './_helpers/output';
import { chatgptAuthCommand } from './chatgptAuth';
import { grokAuthCommand } from './grokAuth';
import { authTokenCommand } from './relayTokens';
import { CliUsageError, type CliContext } from '../runtime/cliContext';

type LoginCommandArgs = {
  readonly providerArg?: string;
  readonly 'no-browser'?: boolean;
  readonly noBrowser?: boolean;
  readonly browser?: boolean;
  readonly device?: boolean;
  readonly 'select-account'?: boolean;
  readonly selectAccount?: boolean;
  readonly 'login-hint'?: string;
  readonly loginHint?: string;
};

export function loginInitFromArgs(args: LoginCommandArgs): CliLoginInit {
  const provider = optString(args.providerArg)?.trim();
  const providerExplicit = isNonEmptyString(provider);
  return {
    provider: providerExplicit ? provider : DEFAULT_OAUTH_PROVIDER,
    providerExplicit,
    noBrowser: booleanArg(args, 'no-browser'),
    device: args.device === true,
    selectAccount: booleanArg(args, 'select-account'),
    loginHint: optString(args['login-hint']) ?? optString(args.loginHint),
  };
}

export function assertLoginTransportExclusive(
  init: Pick<CliLoginInit, 'device' | 'noBrowser'>,
): void {
  if (hasLoginTransportConflict(init)) {
    throw new CliUsageError(LOGIN_TRANSPORT_CONFLICT_MESSAGE);
  }
}

export function shouldPromptForLoginProvider(
  context: Pick<
    CliContext,
    'mode' | 'outputFormat' | 'stdoutIsTty' | 'termIsDumb'
  >,
  init: Pick<CliLoginInit, 'providerExplicit' | 'noBrowser' | 'device'>,
): boolean {
  // Device-code logins pick the provider on the browser verification page,
  // so a terminal-side provider prompt would be redundant.
  return (
    !init.providerExplicit &&
    !init.noBrowser &&
    !init.device &&
    context.outputFormat === 'text' &&
    interactiveTerminalFailure(context) === undefined
  );
}

async function runDeviceLogin(context: CliContext): Promise<number> {
  await initCliPlatform({ ...context, quietLogs: true });
  // Human-facing progress goes to stdout only in text mode so the JSON/NDJSON
  // result stream stays machine-readable (same convention as --no-browser).
  const writeProgress = cliProgressWriter(context);
  let session: SupabaseSession;
  try {
    session = await signInCliSupabaseDeviceCode({
      onDeviceCode: (authorization) => {
        writeProgress(formatCliDeviceAuthMessage(authorization));
        writeProgress(
          'Waiting for you to approve in the browser… (Ctrl-C cancels)',
        );
      },
    });
  } catch (error) {
    writeErrorStderr(error);
    return CliExitCode.ModelOrNetworkError;
  }
  emitLoginResult(context, session);
  return CliExitCode.Success;
}

function emitLoginResult(context: CliContext, session: SupabaseSession): void {
  const expiresAt = new Date(session.expiresAt).toISOString();
  const payload = { authenticated: true, account: session.account, expiresAt };
  emitCliResult(context, {
    json: payload,
    ndjson: { kind: 'auth', ...payload },
    text: `Signed in as ${session.account.label}.`,
  });
}

async function runLogin(
  context: CliContext,
  init: CliLoginInit,
): Promise<number> {
  if (init.device) {
    return runDeviceLogin(context);
  }
  if (!isOAuthProvider(init.provider)) {
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
          cliProgressWriter(context)(formatCliManualAuthUrlMessage(url));
        }
      },
    });
  } catch (error) {
    writeErrorStderr(error);
    return CliExitCode.ModelOrNetworkError;
  }

  emitLoginResult(context, session);
  return CliExitCode.Success;
}

export const loginCommand = withUsageSections(
  defineCliCommand({
    meta: {
      name: 'login',
      description: 'Sign in with Researcher Access',
    },
    args: {
      ...GLOBAL_ARGS,
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
      device: {
        type: 'boolean',
        description:
          'Sign in with a device code from a browser on any device (for SSH, WSL2, and containers)',
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
      const init = loginInitFromArgs(ctx.args);
      assertLoginTransportExclusive(init);
      return runLoginCommand(context, init);
    },
  }),
  [
    {
      title: 'EXAMPLES',
      rows: [
        ['texra auth chatgpt login', 'sign in with a ChatGPT subscription'],
        ['texra auth grok login', 'sign in with a Grok (xAI) subscription'],
        ['texra login', 'sign in with Researcher Access'],
        ['texra login --device', 'sign in to Researcher Access over SSH'],
      ],
    },
  ],
);

export async function runLoginCommand(
  context: CliContext,
  init: CliLoginInit,
): Promise<number> {
  if (!shouldPromptForLoginProvider(context, init)) {
    return runLogin(context, init);
  }

  const { promptForLoginProvider } = await import('./loginProviderPicker');
  const choice = await promptForLoginProvider(context.stdoutColorEnabled);
  if (!choice) {
    writeTextStderr('Cancelled. No sign-in started.');
    return CliExitCode.Success;
  }
  if (choice === 'device') {
    return runDeviceLogin(context);
  }
  return runLogin(context, {
    ...init,
    provider: choice,
    providerExplicit: true,
  });
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

    // Sign-out only clears the stored session; a configured TEXRA_RELAY_TOKEN
    // keeps authenticating relay calls, so report it instead of a clean exit.
    const relayNotice = relayTokenStillActiveNotice();
    const payload = {
      authenticated: false,
      relayTokenConfigured: relayNotice !== undefined,
    };
    emitCliResult(context, {
      json: payload,
      ndjson: { kind: 'auth', ...payload },
      text: supabaseSignOutOutcomeMessage('Signed out.'),
    });
    return CliExitCode.Success;
  },
});

/**
 * Headline line for `texra auth status`. A transient session state means the
 * authentication service could not be reached, not that the user is signed
 * out: the stored session survives, so reporting "Not signed in." would send
 * the user through a sign-in they do not need.
 */
function formatAuthStatusLine(profile: CliAuthProfile): string {
  if (profile.authenticated) {
    return `Signed in as ${profile.accountLabel || 'unknown'} (${profile.tier ?? 'unknown'}).`;
  }
  if (profile.sessionState === 'transient') {
    return 'The authentication service is temporarily unavailable. Your stored session is intact; try again later.';
  }
  return 'Not signed in.';
}

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
      text: [
        formatAuthStatusLine(profile),
        ...(profile.note ? [profile.note] : []),
      ].join('\n'),
    });
    return CliExitCode.Success;
  },
});

const usageCommand = defineCliCommand({
  meta: { name: 'usage', description: 'Show your included access usage' },
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
      // Usage reads usage_logs via PostgREST, which needs a GoTrue session —
      // a relay-scoped CI token cannot read it. Gate on the session itself so
      // a developer with both an env token and an interactive sign-in still
      // gets their usage.
      const sessionToken = await getCliSessionAccessToken();
      if (!sessionToken) {
        writeTextStderr(
          profile.credentialSource === 'relayToken'
            ? 'Run `texra login` to see your usage, or open the account dashboard. TEXRA_RELAY_TOKEN on its own cannot read usage.'
            : 'Not signed in. Run `texra login` first.',
        );
        return CliExitCode.ModelOrNetworkError;
      }
      const tier = (await resolveCliUsageTier(profile)) ?? 'free';
      summary = await fetchRelayUsageSummary({ tier, month });
    } catch (error) {
      writeErrorStderr(error);
      return CliExitCode.ModelOrNetworkError;
    }

    const periodMonth = summary.periodStart.slice(0, 7);
    emitCliResult(context, {
      json: summary,
      ndjson: { kind: 'relay-usage', ...summary },
      text: [
        `${INCLUDED_ACCESS.label} usage for ${periodMonth} (${summary.tier})`,
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
  token: authTokenCommand,
  chatgpt: chatgptAuthCommand,
  grok: grokAuthCommand,
} as const;

export const AUTH_SUBCOMMAND_NAMES: readonly string[] =
  Object.keys(AUTH_SUBCOMMANDS);

export const authCommand = defineCommand({
  meta: {
    name: 'auth',
    description:
      'Sign in with ChatGPT, Grok, or Researcher Access; check status; and view usage',
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
