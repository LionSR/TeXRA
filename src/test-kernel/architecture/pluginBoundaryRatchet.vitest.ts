// Node imports
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Third-party imports
import { Effect, Layer, type Context } from 'effect';
import { describe, expect, it } from 'vitest';

import { type PluginDefinition, type ToolRun } from '@texra-ai/harness/plugins';
import { rootRun, type SessionServices } from '@agent/runtime/rootLaunch';
import { Runs } from '@agent/runtime/runRegistry';

import { texraPlugins } from '@texra/tools/registry';
import {
  ALL_HOST_PRODUCTION_ROOTS,
  collectModuleSpecifiers,
  expectRealCoverage,
  parseSourceFile,
  productionFilesUnder,
  REPO_ROOT,
  stripComments,
} from '../support/repoScan';
import type { ITool, Plugin, ToolResult } from '@texra-ai/harness';

/**
 * Invariants 1 and 6 of the core concepts, for what a plugin brings: its
 * own row kinds (`Plugin.factKinds`) and its services (a `Plugin`'s
 * `processLayer` and `sessionLayer`). Failure modes guarded:
 *
 * - core (the harness's `shared/`, `agent/`) imports a plugin's fact kind,
 *   so a plugin's row kind is hard-coded in core again and a new stateful plugin edits
 *   core;
 * - a plugin row is drafted anywhere but its plugin's fact kind module or the
 *   dispatch that commits a call's facts with its result, or a
 *   plugin reaches the store's append port, so a second append path or a
 *   row no fact kind checks appears;
 * - a plugin's service is reached outside its own plugin's code, which the
 *   step serves it to, and the one host door (the settings Git tab reading
 *   the GitHub plugin's process services through `ToolCatalog`), so plugin
 *   state is used past its switch and its pin. The table holds each
 *   plugin with its services erased (`PluginContext` in `processRuntime.ts`),
 *   so no `ProcessServices` arm names one.
 */
/** The app's plugin fact kinds (the harness's built-ins own none). */
const PLUGIN_FACT_KIND_MODULES =
  /^packages\/(?:harness|texra)\/src\/shared\/plugins\//;
const PLUGIN_FACT_KIND_IMPORT = /^@(?:texra\/)?shared\/plugins\//;
const CORE = /^packages\/harness\/src\/(?:shared|agent)\//;
const APPEND_PORTS =
  /^@(?:controllers\/session\/Database|shared\/session\/database|agent\/runtime\/SessionEvents)$/;
const PLUGIN_ROW = /type:\s*'plugin\.fact'/;

/** Each plugin service and the files that may reach it. */
const PLUGIN_SERVICES: readonly {
  readonly tag: string;
  readonly users: RegExp;
}[] = [
  {
    tag: 'GitHubSubscriptions',
    users:
      /^packages\/texra\/src\/(?:tools\/github\/|controllers\/settingsView\/githubSubscriptions\.ts$)/,
  },
  {
    tag: 'CodexThreads',
    users: /^packages\/texra\/src\/tools\/agentCli\/codex\.ts$/,
  },
  {
    tag: 'ClaudeAgentSessions',
    users: /^packages\/texra\/src\/tools\/agentCli\/claudeAgent\.ts$/,
  },
  // The Lean 4 plugin's port: its tools and probe, and the VS Code host's
  // bridge, which that host passes as the plugin's layer.
  {
    tag: 'LeanLanguageServices',
    users:
      /^packages\/texra\/src\/tools\/lean\/|^packages\/extension\/src\/(?:extension\.ts|frontend\/lean\/VscodeIntegration\.ts)$/,
  },
  // The `core` plugin's Comments UI port: its tool.
  { tag: 'InlineComments', users: /^packages\/texra\/src\/tools\/comment\// },
  // The editor registry of `latex-diagnostics` and `core`: their tools. The
  // hosts that attach to it hold the registry value, never the tag.
  {
    tag: 'EditorHost',
    users:
      /^packages\/texra\/src\/tools\/(?:DiagnosticsTool|OpenPdfTool|editorHost)\.ts$/,
  },
];
/** Where the services are declared, typed and built. */
const SERVICE_HOMES = new Set([
  'packages/texra/src/tools/agentCli/agentCliSessionStores.ts',
  'packages/texra/src/tools/agentCli/claudeAgentPlugin.ts',
  'packages/texra/src/tools/agentCli/codexPlugin.ts',
  'packages/texra/src/tools/registry.ts',
]);

const files = () => ALL_HOST_PRODUCTION_ROOTS.flatMap(productionFilesUnder);
const source = (file: string) =>
  stripComments(readFileSync(resolve(REPO_ROOT, file), 'utf8'));
const specifiers = (file: string) =>
  collectModuleSpecifiers(parseSourceFile(resolve(REPO_ROOT, file)));

describe('plugin boundaries (invariants 1 and 6)', () => {
  it('keeps plugin fact kinds out of core', () => {
    const offenders = files()
      .filter((file) => CORE.test(file) && !PLUGIN_FACT_KIND_MODULES.test(file))
      .filter((file) =>
        specifiers(file).some((s) => PLUGIN_FACT_KIND_IMPORT.test(s)),
      );
    expect(offenders).toEqual([]);
  });

  it('drafts plugin rows only in fact kind modules, which reach no append port', () => {
    const drafts = files()
      .filter((file) => !PLUGIN_FACT_KIND_MODULES.test(file))
      .filter((file) => PLUGIN_ROW.test(source(file)));
    const appends = files()
      .filter((file) => PLUGIN_FACT_KIND_MODULES.test(file))
      .filter((file) => specifiers(file).some((s) => APPEND_PORTS.test(s)));
    // The one generic writer: `factRows` drafts a call's facts
    // (`ToolResult.facts`), which the dispatch commits with its `tool.result`.
    expect({ drafts, appends }).toEqual({
      drafts: ['packages/harness/src/tools/plugins.ts'],
      appends: [],
    });
  });

  it('reaches plugin services only from their plugin and the step', () => {
    const offenders = PLUGIN_SERVICES.flatMap(({ tag, users }) =>
      files()
        .filter((file) => !users.test(file) && !SERVICE_HOMES.has(file))
        .filter((file) => new RegExp(`\\b${tag}\\b`).test(source(file)))
        .map((file) => `${file} reaches ${tag}`),
    );
    expect(offenders).toEqual([]);
  });

  // Document tasks are TeXRA's documents plugin's: the harness knows a
  // plugin's block (`AgentBlock`) and a recipe run, never this one.
  it('keeps the document task out of the harness', () => {
    const offenders = files()
      .filter((file) => file.startsWith('packages/harness/src/'))
      .filter((file) =>
        /document[ _-]?task|\bX_(?:FILE|CONTENT)\b/i.test(source(file)),
      );
    expect(offenders).toEqual([]);
  });

  it('actually scans the production source roots', () => {
    expectRealCoverage(ALL_HOST_PRODUCTION_ROOTS);
  });
});

describe('plugin rosters', () => {
  it('gives every switchable plugin a dashboard card', () => {
    // A switch with no card would be off with nothing to turn it on.
    expect(
      texraPlugins({ name: 'vscode' })
        .filter(
          ({ toggle, card }) => toggle !== undefined && card === undefined,
        )
        .map(({ id }) => id),
    ).toEqual([]);
  });

  // Failure mode: a plugin's tool requires the session's runs, so a host
  // serving exactly a plugin tool's services cannot run it. The compiler
  // refuses it; this probe fails the typecheck if it ever accepts. The
  // call's place in its run (`RunCall`) and the child-launch door
  // (`ChildRuns`) are references with defaults, so they are never a
  // requirement: what keeps `RunCall` from a plugin's tool is that the
  // `plugins` entry does not export it (the deep-import ratchet holds the
  // rest).
  it('refuses a plugin tool that requires the session runs', () => {
    type PluginTool = NonNullable<Plugin['tools']>[number];
    const requiring = <R>(service: R): ITool<Error, R> => ({
      definition: { name: 'probe' },
      call: () => Effect.die(service),
    });
    const probes: PluginTool[] = [
      // @ts-expect-error a plugin's tool never requires the session's runs:
      // ChildRuns is its run door
      requiring<Runs>(null as never),
    ];
    expect(probes).toHaveLength(1);
  });

  // Failure mode: a plugin's tool reaches a root launch (outside any
  // script's budget, under no parent) through the session its run carries.
  // A root launch requires the composition root's `SessionOwner`, which no
  // tool is served: the compiler refuses it.
  it('refuses a plugin tool that launches a root run', () => {
    type PluginTool = NonNullable<Plugin['tools']>[number];
    const calling = <R>(
      call: () => Effect.Effect<ToolResult, Error, R>,
    ): ITool<Error, R> => ({ definition: { name: 'probe' }, call });
    const session = null as unknown as Context.Context<SessionServices>;
    const probes: PluginTool[] = [
      // @ts-expect-error a plugin's tool never reaches a root launch
      calling(() =>
        rootRun({ config: null as never, runId: null as never })
          .pipe(Effect.as(null as unknown as ToolResult))
          .pipe(Effect.provide(session)),
      ),
    ];
    expect(probes).toHaveLength(1);
  });

  // Failure mode: an app plugin's tool holds the session again (its log,
  // its run history, its inbox), past `ChildRuns` and its call's requests.
  // The run a plugin's tool reads names no session, and no file of the
  // app's tools names the handle.
  it("keeps the session out of the app's plugin tools", () => {
    // @ts-expect-error a plugin's tool reads no session off its run
    const probe: ToolRun['session'] = null;
    const holders = files()
      .filter((file) => file.startsWith('packages/texra/src/tools/'))
      .filter((file) => /\bSessionHandle\b/.test(source(file)));
    expect({ probe, holders }).toEqual({ probe: null, holders: [] });
  });

  // Failure mode: a plugin's session layer reads the session's runs, so a
  // service it serves its tools hands them a launch.
  it("refuses a plugin's session layer that reads the session's runs", () => {
    const layers: NonNullable<PluginDefinition<never>['sessionLayer']>[] = [
      // @ts-expect-error a plugin's session layer reads no Runs
      Layer.effectDiscard(Effect.flatMap(Runs, () => Effect.void)),
    ];
    expect(layers).toHaveLength(1);
  });
});
