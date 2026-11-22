/** The Lean 4 plugin: its language-server tools, its programs, its
 *  availability check, its icons and its card. */

// Third-party imports
import { Clock, Effect, Option } from 'effect';

// Local imports
import { definePlugin } from '@texra-ai/worldline/plugins';
import { formatResultCount } from '@texra-ai/worldline/schemas';
import type { TexraPlugin } from '@texra/tools/registry';
import { texraPlugin } from '@texra/tools/texraPlugin';
import { findCommand } from '@texra/utils/system/binaryResolver';
import { directLeanLanguageServices } from './direct/leanServerPool';
import { LeanLanguageServices } from './leanLanguageServices';
import { isLeanServerActive, summarizeLeanServers } from './leanServerInfo';
import { LeanLoogleTool } from './LoogleTool';
import { LEAN4_EXTENSION_ID } from './leanTypes';
import { LEAN_MODULES, LEAN_PROGRAMS } from './programs';
import {
  LeanDiagnosticsTool,
  LeanFileTool,
  LeanProjectTool,
  LeanInspectTool,
} from './LspTools';

/**
 * Lean 4 over the `lake env lean --server` pool, in every host; its probe
 * reports the tools runnable exactly when `lake` is found, the one thing the
 * pool needs. Its programs (`./programs`) check each round of their
 * child's work with its tools, or, `lean-search`, answer with what a child
 * found.
 */
export const lean4: TexraPlugin = texraPlugin({
  ...definePlugin<LeanLanguageServices>({
    id: 'lean4',
    tools: [
      LeanDiagnosticsTool,
      LeanFileTool,
      LeanProjectTool,
      LeanInspectTool,
      LeanLoogleTool,
    ],
    // The script tool's description lists the programs; a run offered
    // `program` without it reads them here.
    prompt: ({ offered }) =>
      [
        ...(offered.includes('lean_diagnostics')
          ? [
              'For Lean 4, build, check and inspect proofs with the `lean_*` tools and search Mathlib with `lean_loogle`. Outline the informal proof first, formalize it, then iterate on the diagnostics until they are clean.',
            ]
          : []),
        ...(offered.includes('program') && !offered.includes('script')
          ? [
              `The Lean programs \`program\` starts: ${Object.entries(
                LEAN_PROGRAMS,
              )
                .map(
                  ([name, { description }]) => `\`${name}\` (${description})`,
                )
                .join('; ')}.`,
            ]
          : []),
      ].join('\n'),
    scriptModules: LEAN_MODULES,
    programs: LEAN_PROGRAMS,
    availability: {
      check: Effect.fn('lean4.availability')(function* () {
        // A probe reads the plugin's servers while its layer is up; it never
        // brings that layer up itself.
        const lean = yield* Effect.serviceOption(LeanLanguageServices);
        const servers = Option.isSome(lean)
          ? yield* lean.value.listServers
          : [];
        const available = (yield* findCommand('lake')) !== null;
        const activeCount = servers.filter(isLeanServerActive).length;
        let statusLabel: string | undefined;
        if (!available) statusLabel = 'Needs setup';
        else if (activeCount > 0)
          statusLabel = `${formatResultCount(activeCount, 'server')} active`;
        const lines = [
          available
            ? '`lake` found on PATH: each Lake project gets its own Lean language server.'
            : 'No `lake` binary was detected. Install elan and make sure `lake` is on PATH to enable Lean tools.',
          '',
          summarizeLeanServers(servers, yield* Clock.currentTimeMillis),
        ];
        return {
          available,
          statusLabel,
          statusDetail: lines.join('\n'),
        };
      }),
    },
    processLayer: { layer: directLeanLanguageServices },
  }),
  icons: {
    lean_diagnostics: 'triangle-exclamation',
    lean_file: 'file-code',
    lean_project: 'folder-tree',
    lean_inspect: 'magnifying-glass-chart',
    lean_loogle: 'magnifying-glass',
  },
  dashboard: {
    name: 'Lean 4 Proof Assistant',
    description:
      'Interact with Lean 4 projects: check diagnostics, inspect terms, and manage files. Active language servers are listed below.',
    setup: {
      installGuide:
        'Setup (requires `lake` on PATH):\n' +
        '  1. Install elan: `curl https://elan.lean-lang.org/elan-init.sh -sSf | sh` (or install the VS Code Lean 4 extension)\n' +
        '  2. Open a folder with a `lakefile.lean` or `lakefile.toml`',
      installUrl: 'https://leanprover-community.github.io/install/',
      installExtensionId: LEAN4_EXTENSION_ID,
      configNotes:
        'Runs one `lake env lean --server` per Lake project while tasks use it.',
    },
  },
});
