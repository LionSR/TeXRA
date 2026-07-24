/**
 * Derives a one-line preview of a tool call's `input`, for use as a
 * header/summary fallback before the tool's own `summary` output exists
 * (e.g. while it is still in progress) — shared by the CLI chat TUI
 * (`packages/cli/src/chat/tui/panes/toolRenderers.tsx`) and the VS Code
 * progress view
 * (`packages/extension/src/progressView/frontend/formatters/logFormatters/toolFormatters.ts`).
 *
 * Both hosts used to hand-maintain their own tool-name-to-preview-field
 * mapping and had quietly drifted: the CLI's generic fallback list had no
 * entry for `codex`'s `prompt` field, so an in-flight `codex` call rendered
 * raw `JSON.stringify(input)` in the TUI while the progress view already
 * showed a clean truncated prompt. This module is the single source of
 * truth for the tool-name-specific half of that mapping.
 */
import { isObject } from '@utils/core';

import { EXECUTIONS_DEFAULT_ACTION } from './executionsDisplay';

function executionsInputPreview(input: Record<string, unknown>): string {
  const action =
    typeof input.action === 'string' && input.action.trim()
      ? input.action.trim()
      : EXECUTIONS_DEFAULT_ACTION;
  const path = typeof input.path === 'string' ? input.path : '';
  return `${action} ${path}`.trim();
}

/** Preview field for tools whose most useful "what is this call doing" text
 *  lives under one specific input key. */
const TOOL_PREVIEW_INPUT_KEY: Readonly<Record<string, string>> = {
  bash: 'command',
  codex: 'prompt',
};

/** Derive a one-line preview of `input` for the named tool. `toolName` must
 *  already be normalized (lowercased, provider prefix stripped, e.g.
 *  `claude:Bash` -> `bash`) — callers own that normalization since it's
 *  host-specific (see `lastSegmentToolName` in the CLI TUI). Returns `''`
 *  when the tool isn't one of the ones with a known preview field — callers
 *  fall back to their own host-specific default (a generic key search, or
 *  nothing at all). */
export function deriveToolInputPreview(
  toolName: string,
  input: unknown,
): string {
  if (!isObject(input)) return '';
  if (toolName === 'executions') return executionsInputPreview(input);
  const key = TOOL_PREVIEW_INPUT_KEY[toolName];
  if (!key) return '';
  const value = input[key];
  return typeof value === 'string' ? value : '';
}
