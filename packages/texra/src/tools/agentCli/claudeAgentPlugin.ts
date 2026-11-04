/** The Claude Code CLI plugin: the `claude_code` tool and its sessions, its
 *  availability check, its icons and its card. */

// Third-party imports
import { Config, Effect, Option } from 'effect';

// Local imports
import { apiKeyEnvName, lookupApiKeyOrigin } from '@texra-ai/llm';
import { Secrets, withLogChannel } from '@texra-ai/harness/host';
import { definePlugin } from '@texra-ai/harness/plugins';
import { CLAUDE_AGENT_SETTINGS } from '@texra/shared/settingsView/integrationSettings';
import {
  ClaudeAgentSessions,
  claudeAgentSessionsLayer,
} from './agentCliSessionStores';
import {
  preferredInstallCommand,
  probeSdkBinaryStatus,
} from './availabilityProbes';
import { ClaudeAgentTool } from './claudeAgent';
import {
  findClaudeBinaryPath,
  importClaudeAgentSdk,
} from './claudeAgentImport';
import type { TexraPlugin } from '../registry';

const anthropicApiKeyEnv = apiKeyEnvName('anthropic');

export const claudeAgent: TexraPlugin = {
  ...definePlugin<ClaudeAgentSessions>({
    // ID kept as `claude-agent` for back-compat with persisted disabled-tool
    // preferences. The user-facing name has been rebranded to "Claude Code CLI"
    // and the tool name string is `claude_code`, but the persistence key is
    // stable.
    id: 'claude-agent',
    tools: [ClaudeAgentTool],
    toggle: 'off',
    sessionLayer: claudeAgentSessionsLayer,
    availability: {
      check: Effect.fn('claudeAgent.availability')(function* () {
        const status = yield* probeSdkBinaryStatus({
          importSdk: importClaudeAgentSdk,
          findBinary: findClaudeBinaryPath,
          importFailedLabel: 'Claude Code SDK import failed',
          binaryNotFoundMessage:
            'Claude Code SDK loaded but native `claude` binary not found. ' +
            'Install via: npm install -g @anthropic-ai/claude-code',
        });
        if (!status.ok)
          return { available: false, statusDetail: status.message };
        // A secret store that will not answer is not the same fact as an
        // unset key. An environment key is still known (the launch uses it
        // first); without one the origin is unknown, and the detail says why.
        const key = yield* lookupApiKeyOrigin(yield* Secrets, 'anthropic').pipe(
          Effect.map((origin) => ({ origin, failure: null })),
          Effect.catchTag('SecretsFailed', (failure) =>
            Effect.logWarning(
              `Reading the Anthropic API key failed: ${failure.message}`,
            ).pipe(
              withLogChannel('claudeAgentPlugin'),
              Effect.annotateLogs({ data: failure }),
              Effect.andThen(
                Config.String(anthropicApiKeyEnv).pipe(
                  Config.option,
                  Effect.orDie,
                ),
              ),
              Effect.map((env) => ({
                origin:
                  Option.isSome(env) && env.value
                    ? ('env' as const)
                    : ('unknown' as const),
                failure: failure.message,
              })),
            ),
          ),
        );
        const hasOauthToken = Option.isSome(
          yield* Config.String('CLAUDE_CODE_OAUTH_TOKEN').pipe(
            Config.option,
            Effect.orDie,
          ),
        );
        const authBits: string[] = [];
        if (key.origin === 'secret')
          authBits.push(`${anthropicApiKeyEnv} (TeXRA Settings)`);
        if (key.origin === 'env')
          authBits.push(`${anthropicApiKeyEnv} (environment)`);
        if (hasOauthToken) authBits.push('CLAUDE_CODE_OAUTH_TOKEN');
        let authNote =
          authBits.length > 0
            ? `Auth detected: ${authBits.join(', ')}.`
            : 'No ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN detected: the CLI will use whatever `claude login` session you have.';
        if (key.failure !== null)
          authNote = `${authBits.length > 0 ? authNote : 'No CLAUDE_CODE_OAUTH_TOKEN detected.'} The ${anthropicApiKeyEnv} in TeXRA Settings could not be read (${key.failure}).`;
        return {
          available: true,
          statusDetail: `Claude CLI ready. Binary: ${status.binaryPath}. ${authNote}`,
        };
      }),
    },
  }),
  // Anthropic's native text-editor tool, which the delegated agent can
  // report even though TeXRA registers no tool of that name.
  icons: { str_replace_editor: 'pencil' },
  card: {
    name: 'Claude Code CLI',
    description:
      'Spin off a Claude Code CLI agent that works in your workspace. It can read files, run commands, edit code, and search the web on your behalf. Use it to delegate focused exploration or implementation while another agent stays in charge.',
    settings: CLAUDE_AGENT_SETTINGS,
    setup: {
      installGuide:
        'Install the Claude Code CLI (choose one):\n\n' +
        '  npm install -g @anthropic-ai/claude-code\n' +
        '  brew install --cask claude-code     (macOS)\n' +
        '  winget install Anthropic.ClaudeCode (Windows)\n\n' +
        'Or use the native installer from https://claude.com/code (recommended).\n' +
        'See: https://code.claude.com/docs/en/setup\n\n' +
        'Authentication (choose one):\n' +
        '  • Set ANTHROPIC_API_KEY in TeXRA Settings → API Keys → Anthropic\n' +
        '  • claude login         : OAuth sign-in (Pro/Max subscription, recommended)\n' +
        '  • claude setup-token   : long-lived OAuth token (CLAUDE_CODE_OAUTH_TOKEN)\n' +
        '  • ANTHROPIC_API_KEY    : environment variable with Console API key',
      installUrl: 'https://code.claude.com/docs/en/setup',
      get installCommand(): string {
        return preferredInstallCommand({
          brew: 'brew install --cask claude-code',
          win32: 'winget install Anthropic.ClaudeCode',
          default: 'npm install -g @anthropic-ai/claude-code',
        });
      },
      authCommand: 'claude login',
      configNotes:
        'Requires the native `claude` binary. Supports OAuth (`claude login`), long-lived tokens (`claude setup-token` → CLAUDE_CODE_OAUTH_TOKEN), or ANTHROPIC_API_KEY (resolved from TeXRA Settings → API Keys or the environment).',
      authNote: 'OAuth, OAuth token, or API key',
    },
  },
};
