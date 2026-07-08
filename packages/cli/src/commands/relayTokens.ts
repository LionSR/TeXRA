// `texra setup-token` and `texra auth token` — CI relay token management.
//
// Thin CLI over the relay-tokens edge function: minting authenticates with
// the normal user session (starting the device-code sign-in first when run
// interactively without one), the plaintext token is printed exactly once,
// and pipelines consume it through the TEXRA_RELAY_TOKEN environment
// variable. List/revoke live under `texra auth token` so rotation has one
// predictable home.

import { defineCommand } from 'citty';

import { RELAY_TOKEN_ENV_VAR } from '@auth/relayToken';

import { CliExitCode } from '../runtime/exitCodes';
import { initCliPlatform } from '../runtime/initPlatform';
import {
  writeErrorStderr,
  writeTextStderr,
  writeTextStdout,
} from '../runtime/logSinks';
import {
  listRelayTokens,
  mintRelayToken,
  revokeRelayToken,
  type MintedRelayToken,
  type RelayTokenInfo,
} from '../runtime/relayTokensClient';
import {
  getCliSessionAccessToken,
  signInCliSupabaseDeviceCode,
} from '../runtime/supabaseAuth';
import { formatCliDeviceAuthMessage } from '../runtime/supabaseAuthDeviceCode';
import { interactiveTerminalFailure } from '../runtime/terminalRequirements';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { GLOBAL_ARGS, optString } from './_helpers/globalArgs';
import { emitCliResult } from './_helpers/output';
import type { CliContext } from '../runtime/cliContext';

const SETUP_TOKEN_DEFAULT_EXPIRES_DAYS = 30;
const SETUP_TOKEN_MAX_EXPIRES_DAYS = 365;

/** Parse --expires; returns undefined (with the reason) for invalid input. */
export function parseSetupTokenExpiresDays(
  raw: string | undefined,
): { days: number } | { error: string } {
  if (raw === undefined) return { days: SETUP_TOKEN_DEFAULT_EXPIRES_DAYS };
  const days = Number(raw);
  if (
    !Number.isInteger(days) ||
    days < 1 ||
    days > SETUP_TOKEN_MAX_EXPIRES_DAYS
  ) {
    return {
      error: `--expires must be a whole number of days between 1 and ${SETUP_TOKEN_MAX_EXPIRES_DAYS}.`,
    };
  }
  return { days };
}

export function formatTokenEnvLine(token: string): string {
  return `${RELAY_TOKEN_ENV_VAR}=${token}`;
}

export function formatMintedTokenText(minted: MintedRelayToken): string {
  return [
    `Minted CI relay token "${minted.name}" (${minted.token_hint}, expires ${minted.expires_at.slice(0, 10)}).`,
    'Store it as a CI secret now — it is shown only once.',
    '',
    formatTokenEnvLine(minted.token),
    '',
    `In CI, set ${RELAY_TOKEN_ENV_VAR} in the environment and run texra normally — no sign-in needed.`,
    'Manage tokens: `texra auth token list` / `texra auth token revoke <id>`.',
  ].join('\n');
}

function relayTokenStateLabel(token: RelayTokenInfo): string {
  if (token.revoked_at) return 'revoked';
  if (new Date(token.expires_at).getTime() <= Date.now()) return 'expired';
  return `expires ${token.expires_at.slice(0, 10)}`;
}

export function formatTokenListText(tokens: readonly RelayTokenInfo[]): string {
  if (tokens.length === 0) {
    return 'No CI relay tokens. Mint one with `texra setup-token`.';
  }
  return tokens
    .map((token) => {
      const lastUsed = token.last_used_at
        ? `last used ${token.last_used_at.slice(0, 10)}`
        : 'never used';
      return `${token.id}  ${token.name} (${token.token_hint})  ${relayTokenStateLabel(token)}, ${lastUsed}`;
    })
    .join('\n');
}

/**
 * Resolve a session access token for token management. When run
 * interactively without a session, starts the device-code sign-in (works on
 * SSH and containers) instead of dead-ending; headless runs get an error.
 */
async function requireSessionAccessToken(
  context: CliContext,
): Promise<string | null> {
  const existing = await getCliSessionAccessToken();
  if (existing) return existing;

  const canPrompt =
    context.outputFormat === 'text' &&
    interactiveTerminalFailure(context) === undefined &&
    context.stdoutIsTty === true;
  if (!canPrompt) {
    writeTextStderr(
      'Not signed in. Run `texra login` first (`texra login --device` works over SSH).',
    );
    return null;
  }

  // Sign-in progress is diagnostics, not the command's result: keep it on
  // stderr so stdout stays reserved for the deliverable (the env line /
  // minted-token output) even if the TTY gate above ever changes.
  writeTextStderr('Not signed in — starting device-code sign-in first.');
  await signInCliSupabaseDeviceCode({
    onDeviceCode: (authorization) => {
      writeTextStderr(formatCliDeviceAuthMessage(authorization));
      writeTextStderr(
        'Waiting for you to approve in the browser… (Ctrl-C cancels)',
      );
    },
  });
  return getCliSessionAccessToken();
}

export const setupTokenCommand = defineCliCommand({
  meta: {
    name: 'setup-token',
    description: 'Mint a long-lived relay token for CI pipelines',
  },
  args: {
    ...GLOBAL_ARGS,
    name: {
      type: 'string',
      description: 'Label for the token, shown in `texra auth token list`',
    },
    expires: {
      type: 'string',
      description: `Days until the token expires (1-${SETUP_TOKEN_MAX_EXPIRES_DAYS}, default ${SETUP_TOKEN_DEFAULT_EXPIRES_DAYS})`,
    },
    'print-env': {
      type: 'boolean',
      description: `Print only ${RELAY_TOKEN_ENV_VAR}=<token> on stdout (e.g. for $GITHUB_ENV)`,
    },
  },
  async run(context, ctx) {
    const expires = parseSetupTokenExpiresDays(optString(ctx.args.expires));
    if ('error' in expires) {
      writeTextStderr(expires.error);
      return CliExitCode.Usage;
    }
    const printEnv =
      ctx.args['print-env'] === true ||
      (ctx.args as Record<string, unknown>).printEnv === true;

    await initCliPlatform({ ...context, quietLogs: true });
    let minted: MintedRelayToken;
    try {
      const accessToken = await requireSessionAccessToken(context);
      if (!accessToken) return CliExitCode.ModelOrNetworkError;
      minted = await mintRelayToken(accessToken, {
        name: optString(ctx.args.name),
        expiresInDays: expires.days,
      });
    } catch (error) {
      writeErrorStderr(error);
      return CliExitCode.ModelOrNetworkError;
    }

    if (printEnv && context.outputFormat === 'text') {
      // Keep stdout to exactly the env line so `>> "$GITHUB_ENV"` and
      // command substitution work; the human guidance goes to stderr.
      writeTextStdout(formatTokenEnvLine(minted.token));
      writeTextStderr(
        `Minted CI relay token "${minted.name}" (${minted.token_hint}, expires ${minted.expires_at.slice(0, 10)}). Shown only once.`,
      );
      return CliExitCode.Success;
    }

    const json = {
      id: minted.id,
      name: minted.name,
      token: minted.token,
      tokenHint: minted.token_hint,
      scopes: minted.scopes,
      createdAt: minted.created_at,
      expiresAt: minted.expires_at,
      envVar: RELAY_TOKEN_ENV_VAR,
    };
    emitCliResult(context, {
      json,
      ndjson: { kind: 'relay-token', ...json },
      text: formatMintedTokenText(minted),
    });
    return CliExitCode.Success;
  },
});

const authTokenListCommand = defineCliCommand({
  meta: { name: 'list', description: 'List your CI relay tokens' },
  args: {
    ...GLOBAL_ARGS,
  },
  async run(context) {
    await initCliPlatform({ ...context, quietLogs: true });
    let tokens: readonly RelayTokenInfo[];
    try {
      const accessToken = await requireSessionAccessToken(context);
      if (!accessToken) return CliExitCode.ModelOrNetworkError;
      tokens = await listRelayTokens(accessToken);
    } catch (error) {
      writeErrorStderr(error);
      return CliExitCode.ModelOrNetworkError;
    }

    emitCliResult(context, {
      json: { tokens },
      ndjson: tokens.map((token) => ({ kind: 'relay-token-info', ...token })),
      text: formatTokenListText(tokens),
    });
    return CliExitCode.Success;
  },
});

const authTokenRevokeCommand = defineCliCommand({
  meta: { name: 'revoke', description: 'Revoke a CI relay token by id' },
  args: {
    ...GLOBAL_ARGS,
    id: {
      type: 'positional',
      required: true,
      description: 'Token id (from `texra auth token list`)',
    },
  },
  async run(context, ctx) {
    const id = optString(ctx.args.id);
    if (!id) {
      writeTextStderr(
        'Token id required. Find it with `texra auth token list`.',
      );
      return CliExitCode.Usage;
    }

    await initCliPlatform({ ...context, quietLogs: true });
    let revoked: { id: string; name: string };
    try {
      const accessToken = await requireSessionAccessToken(context);
      if (!accessToken) return CliExitCode.ModelOrNetworkError;
      revoked = await revokeRelayToken(accessToken, id);
    } catch (error) {
      writeErrorStderr(error);
      return CliExitCode.ModelOrNetworkError;
    }

    emitCliResult(context, {
      json: { revoked },
      ndjson: { kind: 'relay-token-revoked', ...revoked },
      text: `Revoked CI relay token "${revoked.name}". Pipelines using it will stop authenticating immediately.`,
    });
    return CliExitCode.Success;
  },
});

export const authTokenCommand = defineCommand({
  meta: {
    name: 'token',
    description:
      'List and revoke CI relay tokens (mint with `texra setup-token`)',
  },
  args: {
    ...GLOBAL_ARGS,
  },
  default: 'list',
  subCommands: {
    list: authTokenListCommand,
    revoke: authTokenRevokeCommand,
  },
});
