/** The Lean 4 plugin: its language-server tools, its availability check,
 *  its icons and its card. */

// Third-party imports
import { Clock, Effect, Option } from 'effect';

// Local imports
import {
  definePlugin,
  type ProcessPluginLayer,
} from '@texra-ai/harness/plugins';
import { formatResultCount } from '@texra-ai/harness/schemas';
import type { TexraPlugin } from '@texra/tools/registry';
import type { SetupPlatformShape } from '@texra/tools/setup/platform';
import { findCommand } from '@texra/utils/system/binaryResolver';
import { directLeanLanguageServices } from './direct/leanServerPool';
import { LeanLanguageServices } from './leanLanguageServices';
import { isLeanServerActive, summarizeLeanServers } from './leanServerInfo';
import { LEAN4_EXTENSION_ID } from './leanTypes';
import {
  LeanDiagnosticsTool,
  LeanFileTool,
  LeanInspectTool,
  LeanProjectTool,
} from './LspTools';

/**
 * Lean 4 over the direct `lake env lean --server` pool, or over the host's
 * editor bridge in its place; its probe reads the editor extension off the
 * host's setup capabilities.
 */
export const lean4 = (host: {
  readonly setup: SetupPlatformShape;
  readonly services?: ProcessPluginLayer<LeanLanguageServices>['layer'];
}): TexraPlugin => ({
  ...definePlugin<LeanLanguageServices>({
    id: 'lean4',
    tools: [
      LeanDiagnosticsTool,
      LeanFileTool,
      LeanProjectTool,
      LeanInspectTool,
    ],
    availability: {
      check: Effect.fn('lean4.availability')(function* () {
        // A probe reads the plugin's servers while its layer is up; it never
        // brings that layer up itself.
        const lean = yield* Effect.serviceOption(LeanLanguageServices);
        const servers = Option.isSome(lean)
          ? yield* lean.value.listServers
          : [];
        const { extensions } = host.setup;
        const extensionAvailable =
          extensions?.isInstalled(LEAN4_EXTENSION_ID) ?? false;
        const lakeAvailable = (yield* findCommand('lake')) !== null;
        const requiresExtension = extensions !== undefined;
        // VS Code drives Lean through its extension; other hosts spawn lake.
        const available = requiresExtension
          ? extensionAvailable
          : lakeAvailable;
        const activeCount = servers.filter(isLeanServerActive).length;
        let statusLabel: string | undefined;
        if (!available) statusLabel = 'Needs setup';
        else if (activeCount > 0)
          statusLabel = `${formatResultCount(activeCount, 'server')} active`;
        const lines: string[] = [];
        if (extensionAvailable)
          lines.push('VS Code Lean 4 extension installed.');
        if (lakeAvailable && !requiresExtension)
          lines.push('Direct LSP mode available (`lake` on PATH).');
        if (!available)
          lines.push(
            requiresExtension
              ? 'The VS Code build drives Lean through the leanprover.lean4 extension; install it to enable Lean tools. `lake` on PATH alone is not enough here.'
              : 'No `lake` binary was detected. Install elan and make sure `lake` is on PATH to enable Lean tools.',
          );
        lines.push(
          '',
          summarizeLeanServers(servers, yield* Clock.currentTimeMillis),
        );
        return {
          available,
          statusLabel,
          statusDetail: lines.join('\n'),
        };
      }),
    },
    processLayer: {
      layer: host.services ?? directLeanLanguageServices('lake'),
    },
  }),
  icons: {
    lean_diagnostics: 'triangle-exclamation',
    lean_file: 'file-code',
    lean_project: 'folder-tree',
    lean_inspect: 'magnifying-glass-chart',
  },
  card: {
    name: 'Lean 4 Proof Assistant',
    description:
      'Interact with Lean 4 projects: check diagnostics, inspect terms, and manage files. Active language servers are listed below. (lean_loogle needs only network access and is always available.)',
    setup: {
      installGuide:
        'TeXRA can drive Lean 4 in two ways:\n\n' +
        '  • VS Code build: uses the "lean4" extension\n' +
        '    (leanprover.lean4) and its running language server.\n' +
        '  • CLI / desktop build: spawns `lake env lean --server`\n' +
        '    directly (one process per Lake project, stopped when the\n' +
        '    last run using it ends). Requires `lake` (from elan/Lean) on\n' +
        '    PATH; install via\n' +
        '    https://leanprover-community.github.io/install/.\n\n' +
        'Setup (VS Code):\n' +
        '  1. Install the "lean4" extension from VS Code Marketplace\n' +
        '  2. Open a Lean 4 project (with lakefile.lean or lakefile.toml)\n' +
        '  3. The extension will auto-install elan and Lean toolchain\n\n' +
        'Setup (CLI / desktop):\n' +
        '  1. Install elan: `curl https://elan.lean-lang.org/elan-init.sh -sSf | sh`\n' +
        '  2. Make sure `lake` is on PATH in a fresh shell\n' +
        '  3. Open a folder containing a lakefile.lean / lakefile.toml',
      installUrl:
        'https://marketplace.visualstudio.com/items?itemName=leanprover.lean4',
      installExtensionId: LEAN4_EXTENSION_ID,
      configNotes:
        'VS Code build: requires the leanprover.lean4 extension. ' +
        'CLI / desktop builds: requires `lake` on PATH; each Lake project can have its own language server, which stops when the last run using it ends, surfaced below.',
    },
  },
});
