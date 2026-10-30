/** The Lean 4 plugin: its language-server tools, and its card. */

// Local imports
import {
  definePlugin,
  type ProcessPluginLayer,
} from '@texra-ai/harness/plugins';
import { lean4Availability } from '@texra/tools/pluginAvailability';
import type { TexraPlugin } from '@texra/tools/registry';
import type { SetupPlatformShape } from '@texra/tools/setup/platform';
import { directLeanLanguageServices } from './direct/directLspAdapter';
import { LEAN4_EXTENSION_ID } from './leanTypes';
import {
  LeanDiagnosticsTool,
  LeanFileTool,
  LeanInspectTool,
  LeanProjectTool,
} from './LspTools';
import type { LeanLanguageServices } from './leanLanguageServices';

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
    availability: lean4Availability(host.setup),
    processLayer: { layer: host.services ?? directLeanLanguageServices() },
  }),
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
        '    directly (one process per Lake project; idle ones stop\n' +
        '    after thirty minutes). Requires `lake` (from elan/Lean) on\n' +
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
        'CLI / desktop builds: requires `lake` on PATH; each Lake project can have its own language server, and idle ones stop after thirty minutes, surfaced below.',
    },
  },
});
