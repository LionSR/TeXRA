/**
 * Exposes a curated subset of TeXRA's research tools to VS Code's Language
 * Model Tool API (`vscode.lm.registerTool`), so they can be referenced in
 * Copilot Chat (e.g. `#texra_arxiv_search`) and invoked by agent mode.
 *
 * Only context-free, read-only research tools are surfaced — they need no
 * agent runtime state and are safe to call from an arbitrary chat session.
 * The API is feature-detected: on hosts without it (incl. Cursor 1.105) this
 * is a no-op, so the manifest `languageModelTools` contribution is simply
 * ignored there.
 */

import * as vscode from 'vscode';

import * as logger from '@logger/logUtils';
import type { ToolResult } from '@shared/schemas/toolResult';
import { getDefaultToolRegistry } from '@tools/registry';

// Local imports - language model tools
import {
  buildLanguageModelToolInvocationMessage,
  type LanguageModelResearchToolName,
} from './languageModelToolInvocationMessage';

const CHANNEL = 'LanguageModelTools';

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
 * Safe to call unconditionally — it detects API availability and exits early
 * on unsupported hosts.
 */
export function registerLanguageModelTools(
  context: vscode.ExtensionContext,
): void {
  const lm = (vscode as { lm?: Partial<typeof vscode.lm> }).lm;
  if (typeof lm?.registerTool !== 'function') {
    // Language Model Tool API not available (e.g. older Cursor builds); no-op.
    return;
  }

  const registry = getDefaultToolRegistry();
  for (const [lmName, toolName] of Object.entries(LM_TOOL_NAMES)) {
    const tool = registry.get(toolName);
    if (!tool) {
      logger.warn(
        CHANNEL,
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
      ) {
        // The tool runs its own Zod validation and returns a structured error
        // result for bad input, so we forward the raw, manifest-validated input.
        const result = await tool.call(options.input);
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(toResultText(result)),
        ]);
      },
    });
    context.subscriptions.push(disposable);
  }
}
