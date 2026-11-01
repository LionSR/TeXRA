/** The Claude Code CLI plugin: the `claude_code` tool and its sessions, and its card. */

// Local imports
import { definePlugin } from '@texra-ai/harness/plugins';
import { CLAUDE_AGENT_SETTINGS } from '@texra/shared/settingsView/integrationSettings';
import {
  ClaudeAgentSessions,
  claudeAgentSessionsLayer,
} from './agentCliSessionStores';
import { preferredInstallCommand } from './availabilityProbes';
import { ClaudeAgentTool } from './claudeAgent';
import { CLAUDE_CODE_AVAILABILITY } from './pluginAvailability';
import type { TexraPlugin } from './registry';

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
    availability: CLAUDE_CODE_AVAILABILITY,
  }),
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
