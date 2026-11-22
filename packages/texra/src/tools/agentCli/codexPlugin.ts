/** The Codex CLI plugin: the `codex` tool and its threads, its
 *  availability check, its icons and its card. */

// Third-party imports
import { Effect } from 'effect';

// Local imports
import { definePlugin } from '@texra-ai/harness/plugins';
import { CODEX_SETTINGS } from '@texra/shared/settings/integrationSettings';
import { CodexThreads, codexThreadsLayer } from './agentCliSessionStores';
import {
  installCommandLines,
  preferredInstallCommand,
  probeSdkBinaryStatus,
  type InstallCommands,
} from './availabilityProbes';
import { CodexTool } from './codex';
import { findCodexBinaryPath, importCodexClass } from './codexImport';
import type { TexraPlugin } from '../registry';
import { texraPlugin } from '@texra/tools/texraPlugin';

/** A global npm install leaves Windows only shims TeXRA cannot spawn, so
 *  Windows gets OpenAI's own installer: it puts a native `codex.exe` under
 *  `%LOCALAPPDATA%\\Programs\\OpenAI\\Codex\\bin`, a directory `commandDirs`
 *  searches, so the lookup finds it in the window that ran the install. */
const CODEX_INSTALL: InstallCommands = {
  brew: 'brew install codex',
  win32:
    'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
  default: 'npm install -g @openai/codex',
};

export const codex: TexraPlugin = texraPlugin({
  ...definePlugin<CodexThreads>({
    id: 'codex',
    tools: [CodexTool],
    prompt: ({ offered }) =>
      offered.includes('codex')
        ? 'Use `codex` for substantial, self-contained coding work (a feature, a large refactor, an independent second opinion on code) while you keep the research thread.'
        : '',
    toggle: 'off',
    sessionLayer: codexThreadsLayer,
    // A binary lookup that errors (EACCES, EMFILE) stays on the error
    // channel, so the dashboard reports the check as failed rather than the
    // tool as not installed.
    availability: {
      check: () =>
        Effect.map(
          probeSdkBinaryStatus({
            importSdk: importCodexClass,
            findBinary: findCodexBinaryPath,
            importFailedLabel: 'Codex SDK import failed',
            classifyImportError: (msg) =>
              msg.includes('Unsupported platform')
                ? `Platform not supported: ${msg}`
                : undefined,
            binaryLabel: 'Codex SDK loaded but native binary',
            install: CODEX_INSTALL,
          }),
          (status) => ({
            available: status.ok,
            statusDetail: status.ok
              ? `Codex CLI ready. Binary: ${status.binaryPath}`
              : status.message,
          }),
        ),
    },
  }),
  // The tool's own call, and the steps of a Codex turn it reports as calls.
  icons: {
    codex: 'robot',
    codex_patch: 'code-compare',
    codex_thread: 'comments',
    codex_turn: 'check-double',
  },
  terminalOutput: ['codex'],
  dashboard: {
    name: 'OpenAI Codex CLI',
    description:
      'OpenAI Codex agent runtime. Required by the Codex SDK for local code generation and analysis.',
    settings: CODEX_SETTINGS,
    setup: {
      installGuide:
        'Install the Codex CLI (choose one):\n\n' +
        `${installCommandLines(CODEX_INSTALL)}\n\n` +
        'On Windows, use the Windows command: it installs a native codex.exe,\n' +
        'which TeXRA needs (a global npm install there leaves only shell shims).\n' +
        'See: https://developers.openai.com/codex/cli\n\n' +
        'Authentication (choose one):\n' +
        '  • codex login       : sign in with ChatGPT account (recommended)\n' +
        '  • OPENAI_API_KEY    : environment variable with API key',
      installUrl: 'https://github.com/openai/codex',
      get installCommand(): string {
        return preferredInstallCommand(CODEX_INSTALL);
      },
      authCommand: 'codex login',
      configNotes:
        'Requires the native `codex` binary, which @openai/codex-sdk drives.',
      authNote: 'Uses ChatGPT subscription (free with Plus/Pro)',
    },
  },
});
