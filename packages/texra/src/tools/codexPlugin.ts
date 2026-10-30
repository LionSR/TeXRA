/** The Codex CLI plugin: the `codex` tool and its threads, and its card. */

// Local imports
import { definePlugin } from '@texra-ai/harness/plugins';
import { CODEX_SETTINGS } from '@texra/shared/settingsView/integrationSettings';
import { CodexThreads, codexThreadsLayer } from './agentCliSessionStores';
import { preferredInstallCommand } from './availabilityProbes';
import { CodexTool } from './codex';
import { CODEX_AVAILABILITY } from './pluginAvailability';
import type { TexraPlugin } from './registry';

export const codex: TexraPlugin = {
  ...definePlugin<CodexThreads>({
    id: 'codex',
    tools: [CodexTool],
    toggle: 'off',
    sessionLayer: codexThreadsLayer,
    availability: CODEX_AVAILABILITY,
  }),
  card: {
    name: 'OpenAI Codex CLI',
    description:
      'OpenAI Codex agent runtime. Required by the Codex SDK for local code generation and analysis.',
    settings: CODEX_SETTINGS,
    setup: {
      installGuide:
        'Install the Codex CLI (choose one):\n\n' +
        '  npm install -g @openai/codex\n' +
        '  brew install codex          (macOS)\n\n' +
        'On Windows, use WSL or the Codex app.\n' +
        'In WSL, install inside the WSL environment (not on the Windows side).\n' +
        'See: https://developers.openai.com/codex/cli\n\n' +
        'Authentication (choose one):\n' +
        '  • codex login       : sign in with ChatGPT account (recommended)\n' +
        '  • OPENAI_API_KEY    : environment variable with API key',
      installUrl: 'https://github.com/openai/codex',
      get installCommand(): string {
        return preferredInstallCommand({
          brew: 'brew install codex',
          default: 'npm install -g @openai/codex',
        });
      },
      authCommand: 'codex login',
      configNotes:
        'Requires @openai/codex npm package with platform binaries. Used by @openai/codex-sdk. ' +
        'Supports OAuth via `codex login` or OPENAI_API_KEY env var.',
      authNote: 'Uses ChatGPT subscription (free with Plus/Pro)',
    },
  },
};
