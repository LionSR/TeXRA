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
import { booleanArg, GLOBAL_ARGS, optString } from './_helpers/globalArgs';
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

function mintedTokenHeadline(minted: MintedRelayToken): string {
  return `Created CI token "${minted.name}" (${minted.token_hint}, expires ${minted.expires_at.slice(0, 10)}).`;
}

export function formatMintedTokenText(minted: MintedRelayToken): string {
  return [
    mintedTokenHeadline(minted),
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
    return 'No CI tokens. Create one with `texra setup-token`.';
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
 * Initialize the platform, resolve a session token, and run one relay-token
 * operation. When run interactively without a session, starts the device-code
 * sign-in (works on SSH and containers) instead of dead-ending; headless runs
 * get an error. Returns undefined once the failure (no session, or a
 * network / edge-function error) has been reported on stderr.
 */
async function withRelayTokenSession<T>(
  context: CliContext,
  operation: (accessToken: string) => Promise<T>,
): Promise<{ value: T } | undefined> {
  await initCliPlatform({ ...context, quietLogs: true });
  try {
    let accessToken = await getCliSessionAccessToken();
    if (!accessToken) {
      const canPrompt =
        context.outputFormat === 'text' &&
        interactiveTerminalFailure(context) === undefined &&
        context.stdoutIsTty === true;
      if (!canPrompt) {
        writeTextStderr(
          'Not signed in. Run `texra login` first (`texra login --device` works over SSH).',
        );
        return undefined;
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
      accessToken = await getCliSessionAccessToken();
    }
    if (!accessToken) return undefined;
    return { value: await operation(accessToken) };
  } catch (error) {
    writeErrorStderr(error);
    return undefined;
  }
}

export const setupTokenCommand = defineCliCommand({
  meta: {
    name: 'setup-token',
    description: 'Create a long-lived token for CI pipelines',
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
    const printEnv = booleanArg(ctx.args, 'print-env');

    const session = await withRelayTokenSession(context, (accessToken) =>
      mintRelayToken(accessToken, {
        name: optString(ctx.args.name),
        expiresInDays: expires.days,
      }),
    );
    if (!session) return CliExitCode.ModelOrNetworkError;
    const minted = session.value;

    if (printEnv && context.outputFormat === 'text') {
      // Keep stdout to exactly the env line so `>> "$GITHUB_ENV"` and
      // command substitution work; the human guidance goes to stderr.
      writeTextStdout(formatTokenEnvLine(minted.token));
      writeTextStderr(`${mintedTokenHeadline(minted)} Shown only once.`);
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
  meta: { name: 'list', description: 'List your CI tokens' },
  args: {
    ...GLOBAL_ARGS,
  },
  async run(context) {
    const session = await withRelayTokenSession(context, (accessToken) =>
      listRelayTokens(accessToken),
    );
    if (!session) return CliExitCode.ModelOrNetworkError;
    const tokens = session.value;

    emitCliResult(context, {
      json: { tokens },
      ndjson: tokens.map((token) => ({ kind: 'relay-token-info', ...token })),
      text: formatTokenListText(tokens),
    });
    return CliExitCode.Success;
  },
});

const authTokenRevokeCommand = defineCliCommand({
  meta: { name: 'revoke', description: 'Revoke a CI token by id' },
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

    const session = await withRelayTokenSession(context, (accessToken) =>
      revokeRelayToken(accessToken, id),
    );
    if (!session) return CliExitCode.ModelOrNetworkError;
    const revoked = session.value;

    emitCliResult(context, {
      json: { revoked },
      ndjson: { kind: 'relay-token-revoked', ...revoked },
      text: `Revoked CI token "${revoked.name}". Pipelines using it will stop authenticating immediately.`,
    });
    return CliExitCode.Success;
  },
});

export const authTokenCommand = defineCommand({
  meta: {
    name: 'token',
    description:
      'List and revoke CI tokens (create one with `texra setup-token`)',
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
