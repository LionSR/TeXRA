/**
 * Exposes a curated subset of TeXRA's research tools to VS Code's Language
 * Model Tool API (`vscode.lm.registerTool`), so they can be referenced in
 * Copilot Chat (e.g. `#texra_arxiv_search`) and invoked by agent mode.
 *
 * Only context-free, read-only research tools are surfaced — they need no
 * agent runtime state and are safe to call from an arbitrary chat session.
 * Registration is guarded at this multi-host boundary because compatible
 * non-VS Code hosts can expose only part of the `vscode.lm` namespace.
 */

import * as vscode from 'vscode';
import { Effect, Fiber } from 'effect';

import { FileInteractionState, ToolCall } from '@agent/runtime';
import { createLog } from '@logger/logUtils';
import type { ConfigProvider } from '@platform/interfaces';
import type { ProcessRuntime } from '@platform/processRuntime';

import type { ToolResult } from '@shared/schemas';
import { getDefaultToolRegistry } from '@tools/registry';

// Local imports - language model tools
import {
  buildLanguageModelToolInvocationMessage,
  type LanguageModelResearchToolName,
} from './languageModelToolInvocationMessage';

const log = createLog('LanguageModelTools');

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
 * Register the curated TeXRA tools with the VS Code Language Model Tool API.
 */
export function registerLanguageModelTools(
  context: vscode.ExtensionContext,
  runtime: ProcessRuntime,
  config: ConfigProvider,
): void {
  const lm = (vscode as { lm?: Partial<typeof vscode.lm> }).lm;
  if (typeof lm?.registerTool !== 'function') return;

  const registry = getDefaultToolRegistry();
  for (const [lmName, toolName] of Object.entries(LM_TOOL_NAMES)) {
    const tool = registry.get(toolName);
    if (!tool) {
      log.warn(
        `Tool "${toolName}" missing from registry; skipping LM registration for "${lmName}".`,
      );
      continue;
    }
    const disposable = lm.registerTool(lmName, {
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
        const invocation = runtime.runFork(
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
                  config,
                  tracker: new FileInteractionState(),
                  run: undefined,
                  inScope: (operation) => operation(),
                }),
              );
            }),
          ),
        );
        const result = await runtime.runPromise(Fiber.join(invocation));
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(toResultText(result)),
        ]);
      },
    });
    context.subscriptions.push(disposable);
  }
}
