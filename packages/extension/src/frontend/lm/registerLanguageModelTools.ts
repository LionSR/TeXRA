/**
 * Exposes a curated subset of TeXRA's research tools to VS Code's Language
 * Model Tool API (`vscode.lm.registerTool`), so they can be referenced in
 * Copilot Chat (e.g. `#texra_arxiv_search`) and invoked by agent mode.
 *
 * This is the `copilot` plugin's process layer, which this host passes with
 * TeXRA's plugins (`texraPlugins` in `@tools/registry`) to
 * `processLayer`: it is up while the plugin is on, and closing it
 * disposes every registration. While up, Copilot sees each of these tools
 * whose plugin is on in the tool catalog (`@tools/liveTools`), and follows
 * each change of the switches, which reach the catalog at once
 * (`pluginCatalogLayer`): a switched-off plugin's tool leaves Copilot with
 * it.
 *
 * Only context-free, read-only research tools are surfaced — they need no
 * agent runtime state and are safe to call from an arbitrary chat session.
 * Registration is guarded at this multi-host boundary because compatible
 * non-VS Code hosts can expose only part of the `vscode.lm` namespace.
 */

import * as vscode from 'vscode';
import { Context, Data, Effect, Fiber, Layer, Option, Stream } from 'effect';

import {
  ToolContext,
  type PluginContext,
  type ProcessRuntime,
  type WorkspaceRoots,
} from '@texra-ai/harness';
import {
  ChildRuns,
  WebFetchTool,
  type PluginToolServices,
} from '@texra-ai/harness/plugins';
import { sessionFsLayer } from '@texra-ai/harness';

import type { ToolResult } from '@shared/schemas';
import { ArxivSearchTool } from '@texra/tools/arxiv/ArxivSearchTool';
import { ToolCatalog } from '@tools/liveTools';
import type { ProcessPluginLayer } from '@tools/toolTable';
import { generateShortId } from '@utils/core';

// Local imports - language model tools
import {
  buildLanguageModelToolInvocationMessage,
  type LanguageModelResearchToolName,
} from './languageModelToolInvocationMessage';

/** A tool Copilot can call: one whose call requires only what a plugin's
 *  tool is served outside a run (`PluginToolServices`: the call's context,
 *  the window's rooted files, a refusing `ChildRuns`, process services). A
 *  tool that reads a run's own services does not compile here. */
interface CopilotTool {
  call(input: unknown): Effect.Effect<ToolResult, Error, PluginToolServices>;
}

/** VS Code tool name (manifest) → the TeXRA tool it calls, typed from its
 *  defining module; the catalog says only whether its plugin is on. */
const LM_TOOLS = {
  texra_arxiv_search: { name: 'arxiv_search', tool: ArxivSearchTool },
  texra_web_fetch: { name: 'web_fetch', tool: WebFetchTool },
} as const satisfies Record<
  string,
  { readonly name: LanguageModelResearchToolName; readonly tool: CopilotTool }
>;

/** Flatten a TeXRA ToolResult into the plain text VS Code chat expects. */
function toResultText(result: ToolResult): string {
  if (result.status === 'error') {
    return result.error;
  }
  return result.output ?? result.summary ?? '(no output)';
}

// A Copilot call is under no run, so it launches and reads none.
class CopilotToolRunRefused extends Data.TaggedError('CopilotToolRunRefused')<{
  readonly message: string;
}> {}
const noRun = Effect.fail(
  new CopilotToolRunRefused({ message: 'A Copilot tool call is under no run' }),
);
const refusingChildRuns = Layer.succeed(ChildRuns)({
  launch: () => noRun,
  launchProcess: () => noRun,
  inbox: () => noRun,
  parent: () => noRun,
  records: () => ({ exists: noRun, end: noRun }),
  rows: () => noRun,
});

/**
 * The `copilot` plugin's process layer: the curated TeXRA tools registered
 * with the VS Code Language Model Tool API while the tool catalog offers
 * them, for as long as the layer is up. A call runs on the process runtime
 * over the window's roots, read when the call arrives.
 */
export const copilotToolsLayer = (
  runtime: () => ProcessRuntime,
  roots: () => WorkspaceRoots | undefined,
): ProcessPluginLayer => ({
  layer: Layer.effectDiscard(copilotTools(runtime, roots)),
});

const copilotTools = Effect.fnUntraced(function* (
  processRuntime: () => ProcessRuntime,
  windowRoots: () => WorkspaceRoots | undefined,
) {
  const lm = (vscode as { lm?: Partial<typeof vscode.lm> }).lm;
  if (typeof lm?.registerTool !== 'function') return;
  const registerTool = lm.registerTool.bind(lm);
  const catalog = yield* ToolCatalog;
  const registered = new Map<string, vscode.Disposable>();
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => registered.forEach((disposable) => disposable.dispose())),
  );
  const register = (
    lmName: string,
    toolName: LanguageModelResearchToolName,
    tool: CopilotTool,
    plugin: string,
  ) =>
    registerTool(lmName, {
      prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<unknown>,
      ) {
        return {
          invocationMessage: buildLanguageModelToolInvocationMessage(
            toolName,
            options.input,
          ),
        };
      },
      async invoke(
        options: vscode.LanguageModelToolInvocationOptions<unknown>,
        token: vscode.CancellationToken,
      ) {
        const runtime = processRuntime();
        // The window's roots, which are gone once its workspace has closed.
        const roots = windowRoots();
        if (roots === undefined)
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
              'TeXRA has no open workspace to run this tool in.',
            ),
          ]);
        // Run the invocation directly on the process runtime rather than
        // forking and joining it: the effect's failure is delivered to the
        // awaited `runPromise` caller only, never to the fork-failure
        // reporting seam (#12663). Cancellation interrupts the in-flight
        // effect through the token's own handler.
        const result = await runtime.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const fiber = yield* Effect.fiber;
              yield* Effect.acquireRelease(
                Effect.sync(() =>
                  token.onCancellationRequested(() => {
                    runtime.runFork(Fiber.interrupt(fiber));
                  }),
                ),
                (subscription) => Effect.sync(() => subscription.dispose()),
              );
              if (token.isCancellationRequested) return yield* Effect.interrupt;
              // Its plugin's process services, as a step would serve them
              // (the research tools' plugins own none).
              const services = yield* catalog.processServices(plugin);
              return yield* tool.call(options.input).pipe(
                Effect.provide(
                  Option.getOrElse(
                    services,
                    () => Context.empty() as PluginContext,
                  ),
                ),
                Effect.provideService(ToolContext, {
                  // Copilot's invocation names no call id of its own.
                  callId: `${lmName}-${generateShortId()}`,
                  env: { roots },
                  emit: () => undefined,
                }),
                Effect.provide(refusingChildRuns),
                // Every `WorkspaceFs`/`StorageFs` service read in this call
                // resolves against the window's folders, and path resolution
                // takes `ToolContext.env` as data.
                Effect.provide(sessionFsLayer(roots)),
              );
            }),
          ),
        );
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(toResultText(result)),
        ]);
      },
    });
  // The built-in tools as the switches stand, then on each change.
  yield* catalog.current.pipe(
    Stream.runForEach((entries) =>
      Effect.sync(() => {
        for (const [lmName, { name, tool }] of Object.entries(LM_TOOLS)) {
          const entry = entries.get(name);
          const held = registered.get(lmName);
          if (entry !== undefined && held === undefined) {
            registered.set(lmName, register(lmName, name, tool, entry.plugin));
          } else if (entry === undefined && held !== undefined) {
            held.dispose();
            registered.delete(lmName);
          }
        }
      }),
    ),
    Effect.forkScoped,
  );
});
