import { defineCommand } from 'citty';

import { DEFAULT_OAUTH_PROVIDER } from '@auth/config';
import { isOAuthProvider } from '@auth/sharedConfig';
import { toErrorMessage } from '@common/errors/errorMessage';
import { isNonEmptyString } from '@utils/core/stringCore';

import { CliExitCode } from '../runtime/exitCodes';
import { initCliPlatform } from '../runtime/initPlatform';
import {
  writeNdjsonStdout,
  writeTextStderr,
  writeTextStdout,
} from '../runtime/logSinks';
import {
  fetchRelayUsageSummary,
  parseUtcMonth,
  type RelayUsageSummary,
} from '../runtime/relayUsage';
import {
  getCliAuthProfile,
  signInCliSupabase,
  signOutCliSupabase,
} from '../runtime/supabaseAuth';

import { contextFromArgs } from './_helpers/context';
import { setExitCode } from './_helpers/exitCode';
import { GLOBAL_ARGS, optString } from './_helpers/globalArgs';
import type { CliContext } from '../runtime/cliContext';

export function resolveLoginProvider(
  positional: string | undefined,
  flag: string | undefined,
): string {
  if (isNonEmptyString(flag)) return flag.trim();
  if (isNonEmptyString(positional)) return positional.trim();
  return DEFAULT_OAUTH_PROVIDER;
}

interface LoginInit {
  readonly provider: string;
  readonly noBrowser: boolean;
  readonly selectAccount: boolean;
  readonly loginHint?: string;
}

async function runLogin(context: CliContext, init: LoginInit): Promise<number> {
  if (!isOAuthProvider(init.provider)) {
    writeTextStderr(
      `Unsupported provider: ${init.provider}. Expected github or google.`,
    );
    return CliExitCode.Usage;
  }
  await initCliPlatform({ ...context, quietLogs: true });
  if (init.provider === 'github' && init.selectAccount && !init.loginHint) {
    writeTextStderr(
      'GitHub does not support --select-account by itself. Use --login-hint <username> to request a specific GitHub account.',
    );
  }
  if (context.outputFormat === 'text' && !init.noBrowser) {
    writeTextStdout(`Opening browser for TeXRA ${init.provider} sign-in...`);
  }
  let session: Awaited<ReturnType<typeof signInCliSupabase>>;
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
          writeAuthUrl(`Open this URL to sign in:\n${url}`);
        }
      },
    });
  } catch (error) {
    writeTextStderr(toErrorMessage(error));
    return CliExitCode.ModelOrNetworkError;
  }

  if (context.outputFormat === 'json') {
    writeTextStdout(
      JSON.stringify(
        {
          authenticated: true,
          account: session.account,
          expiresAt: new Date(session.expiresAt).toISOString(),
        },
        null,
        2,
      ),
    );
  } else if (context.outputFormat === 'ndjson') {
    writeNdjsonStdout({
      kind: 'auth',
      ts: new Date().toISOString(),
      authenticated: true,
      account: session.account,
      expiresAt: new Date(session.expiresAt).toISOString(),
    });
  } else {
    writeTextStdout(`Signed in as ${session.account.label}.`);
  }
  return CliExitCode.Success;
}

export const loginCommand = defineCommand({
  meta: { name: 'login', description: 'Sign in to TeXRA for included access' },
  args: {
    ...GLOBAL_ARGS,
    provider: {
      type: 'string',
      description:
        'OAuth provider: github or google (alternative to positional)',
    },
    providerArg: {
      type: 'positional',
      required: false,
      description: 'OAuth provider: github or google',
    },
    'no-browser': {
      type: 'boolean',
      description: 'Print the sign-in URL instead of opening a browser',
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
  async run(ctx) {
    const context = await contextFromArgs(ctx.args);
    const positional = optString(ctx.args.providerArg);
    const flag = optString(ctx.args.provider);
    const provider = resolveLoginProvider(positional, flag);
    setExitCode(
      await runLogin(context, {
        provider,
        noBrowser: ctx.args['no-browser'] === true,
        selectAccount: ctx.args['select-account'] === true,
        loginHint: optString(ctx.args['login-hint']),
      }),
    );
  },
});

export const logoutCommand = defineCommand({
  meta: { name: 'logout', description: 'Sign out of TeXRA' },
  args: {
    ...GLOBAL_ARGS,
  },
  async run(ctx) {
    const context = await contextFromArgs(ctx.args);
    await initCliPlatform({ ...context, quietLogs: true });
    try {
      await signOutCliSupabase();
    } catch (error) {
      writeTextStderr(toErrorMessage(error));
      setExitCode(CliExitCode.ModelOrNetworkError);
      return;
    }

    if (context.outputFormat === 'json') {
      writeTextStdout(JSON.stringify({ authenticated: false }, null, 2));
    } else if (context.outputFormat === 'ndjson') {
      writeNdjsonStdout({
        kind: 'auth',
        ts: new Date().toISOString(),
        authenticated: false,
      });
    } else {
      writeTextStdout('Signed out.');
    }
    setExitCode(CliExitCode.Success);
  },
});

const authStatusCommand = defineCommand({
  meta: { name: 'status', description: 'Show TeXRA sign-in status' },
  args: {
    ...GLOBAL_ARGS,
  },
  async run(ctx) {
    const context = await contextFromArgs(ctx.args);
    let profile: Awaited<ReturnType<typeof getCliAuthProfile>>;
    try {
      await initCliPlatform({ ...context, quietLogs: true });
      profile = await getCliAuthProfile();
    } catch (error) {
      writeTextStderr(toErrorMessage(error));
      setExitCode(CliExitCode.ModelOrNetworkError);
      return;
    }

    if (context.outputFormat === 'json') {
      writeTextStdout(JSON.stringify(profile, null, 2));
    } else if (context.outputFormat === 'ndjson') {
      writeNdjsonStdout({
        kind: 'auth-status',
        ts: new Date().toISOString(),
        ...profile,
      });
    } else if (profile.authenticated) {
      writeTextStdout(
        `Signed in as ${profile.accountLabel ?? 'unknown'} (${profile.tier ?? 'unknown'}).`,
      );
    } else {
      writeTextStdout('Not signed in.');
    }
    setExitCode(CliExitCode.Success);
  },
});

function writeRelayUsageSummary(
  context: CliContext,
  summary: RelayUsageSummary,
): void {
  if (context.outputFormat === 'json') {
    writeTextStdout(JSON.stringify(summary, null, 2));
    return;
  }

  if (context.outputFormat === 'ndjson') {
    writeNdjsonStdout({
      kind: 'relay-usage',
      ts: new Date().toISOString(),
      ...summary,
    });
    return;
  }

  const month = summary.periodStart.slice(0, 7);
  writeTextStdout(
    [
      `Relay usage for ${month} (${summary.tier})`,
      `Spend: $${summary.costUsd.toFixed(2)} / $${summary.limitUsd.toFixed(2)} (${summary.usagePercent.toFixed(1)}%)`,
      `Remaining: $${summary.remainingUsd.toFixed(2)}`,
      `Streams: ${summary.streamCount}`,
      `Tokens: ${summary.inputTokens} input (${summary.cachedTokens} cached), ${summary.outputTokens} output, ${summary.reasoningTokens} reasoning`,
      `Models: ${summary.modelsUsed}; providers: ${summary.providersUsed}`,
    ].join('\n'),
  );
}

export const usageCommand = defineCommand({
  meta: { name: 'usage', description: 'Show relay usage for this account' },
  args: {
    ...GLOBAL_ARGS,
    month: {
      type: 'string',
      description: 'UTC month to show, formatted as YYYY-MM',
    },
  },
  async run(ctx) {
    const context = await contextFromArgs(ctx.args);
    const month = optString(ctx.args.month);
    // Pre-validate `--month` before any network I/O so a malformed value
    // yields a Usage error (exit 2), not the catch-all ModelOrNetworkError
    // (exit 3) that the broader try/catch below would assign.
    if (month) {
      try {
        parseUtcMonth(month);
      } catch (error) {
        writeTextStderr(toErrorMessage(error));
        setExitCode(CliExitCode.Usage);
        return;
      }
    }
    let summary: RelayUsageSummary;
    try {
      await initCliPlatform({ ...context, quietLogs: true });
      const profile = await getCliAuthProfile();
      if (!profile.authenticated) {
        writeTextStderr('Not signed in. Run `texra login` first.');
        setExitCode(CliExitCode.ModelOrNetworkError);
        return;
      }
      summary = await fetchRelayUsageSummary({
        tier: profile.tier ?? 'free',
        month,
      });
    } catch (error) {
      writeTextStderr(toErrorMessage(error));
      setExitCode(CliExitCode.ModelOrNetworkError);
      return;
    }

    writeRelayUsageSummary(context, summary);
    setExitCode(CliExitCode.Success);
  },
});

export const authCommand = defineCommand({
  meta: { name: 'auth', description: 'Authentication commands' },
  subCommands: { status: authStatusCommand, usage: usageCommand },
});
