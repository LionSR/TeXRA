/**
 * Exposes a curated subset of TeXRA's research tools to VS Code's Language
 * Model Tool API (`vscode.lm.registerTool`), so they can be referenced in
 * Copilot Chat (e.g. `#texra_arxiv_search`) and invoked by agent mode.
 *
 * This is the `copilot` plugin's contribution (`@tools/pluginManifest`),
 * VS Code only: while its switch is on, Copilot sees each of these tools
 * that the live catalog's current generation (`@tools/liveTools`) holds;
 * switched off, every registration is disposed. It re-reads on each
 * generation the catalog publishes and on each switch flipped in this
 * process.
 *
 * Only context-free, read-only research tools are surfaced — they need no
 * agent runtime state and are safe to call from an arbitrary chat session.
 * Registration is guarded at this multi-host boundary because compatible
 * non-VS Code hosts can expose only part of the `vscode.lm` namespace.
 */

import * as vscode from 'vscode';
import { Effect, Fiber, Queue, Stream, SubscriptionRef } from 'effect';

import { Runs, ToolCall, type SessionHandle } from '@agent/runtime';
import { onAppSignal } from '@eventBus/AppSignals';
import { withLogChannel } from '@logger/effectLog';
import { AppState } from '@platform/interfaces';
import type { ProcessRuntime } from '@platform/processRuntime';
import { sessionFsLayer } from '@platform/rootedFs';

import type { ToolResult } from '@shared/schemas';
import { LiveTools, type ToolEntry } from '@tools/liveTools';
import { switchedOffPlugins } from '@tools/plugins';
import { getDisabledToolIds } from '@utils/config/constants';

// Local imports - language model tools
import {
  buildLanguageModelToolInvocationMessage,
  type LanguageModelResearchToolName,
} from './languageModelToolInvocationMessage';

/** VS Code tool name (manifest) → canonical TeXRA registry tool name. */
const LM_TOOL_NAMES = {
  texra_arxiv_search: 'arxiv_search',
  texra_web_fetch: 'web_fetch',
  texra_crossref_search: 'crossref_search',
} as const satisfies Record<string, LanguageModelResearchToolName>;

/** Flatten a TeXRA ToolResult into the plain text VS Code chat expects. */
function toResultText(result: ToolResult): string {
  if (result.status === 'error') {
    return result.error;
  }
  return result.output ?? result.summary ?? '(no output)';
}

/**
 * Register the curated TeXRA tools with the VS Code Language Model Tool API
 * while the live catalog offers them, for the caller's scope (the
 * extension's activation), invoked on `session`: its roots and its runs.
 */
export const registerLanguageModelTools = Effect.fn(
  'registerLanguageModelTools',
)(function* (runtime: ProcessRuntime, session: SessionHandle) {
  const lm = (vscode as { lm?: Partial<typeof vscode.lm> }).lm;
  if (typeof lm?.registerTool !== 'function') return;
  const registerTool = lm.registerTool.bind(lm);
  const live = yield* LiveTools;
  const appState = yield* AppState;
  const registered = new Map<string, vscode.Disposable>();
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => registered.forEach((disposable) => disposable.dispose())),
  );
  const register = (
    lmName: string,
    toolName: LanguageModelResearchToolName,
    tool: ToolEntry['tool'],
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
        // The LM manifest intentionally exposes the search-only Crossref
        // surface; adapt that narrower host contract to the canonical
        // command-dispatched registry tool at this boundary.
        const input =
          toolName === 'crossref_search'
            ? {
                ...(options.input as Record<string, unknown>),
                command: 'search',
              }
            : options.input;
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
              return yield* tool.call(input).pipe(
                Effect.provideService(ToolCall, {
                  roots: session.roots,
                  run: undefined,
                }),
                Effect.provideService(Runs, session.runs),
                // Every `WorkspaceFs`/`StorageFs` service read in this call
                // resolves against this session's folders, and path resolution
                // takes `ToolCall.roots` as data.
                Effect.provide(sessionFsLayer(session.roots)),
              );
            }),
          ),
        );
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(toResultText(result)),
        ]);
      },
    });
  const follow = Effect.gen(function* () {
    const { entries } = yield* SubscriptionRef.get(live.registry.current);
    const off = switchedOffPlugins(yield* getDisabledToolIds(appState));
    for (const [lmName, toolName] of Object.entries(LM_TOOL_NAMES)) {
      const entry = off.has('copilot') ? undefined : entries.get(toolName);
      const held = registered.get(lmName);
      if (entry !== undefined && held === undefined) {
        registered.set(lmName, register(lmName, toolName, entry.tool));
      } else if (entry === undefined && held !== undefined) {
        held.dispose();
        registered.delete(lmName);
      }
    }
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning(
        `Copilot tools were not updated: ${error.message}`,
      ).pipe(withLogChannel('LanguageModelTools')),
    ),
  );
  // The current generation first, then each change and each switch.
  yield* Stream.merge(
    SubscriptionRef.changes(live.registry.current),
    Stream.callback<void>((queue) =>
      onAppSignal('toolSwitchesChanged', () =>
        Queue.offerUnsafe(queue, undefined),
      ),
    ),
  ).pipe(
    Stream.runForEach(() => follow),
    Effect.forkScoped,
  );
});
