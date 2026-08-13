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

import { executionsAction } from './executionsDisplay';
import { normalizeToolName } from './toolDisplayName';

function executionsInputPreview(input: Record<string, unknown>): string {
  const path = typeof input.path === 'string' ? input.path : '';
  return `${executionsAction(input)} ${path}`.trim();
}

/** Preview field for tools whose most useful "what is this call doing" text
 *  lives under one specific input key. */
const TOOL_PREVIEW_INPUT_KEY: Readonly<Record<string, string>> = {
  bash: 'command',
  codex: 'prompt',
};

/** Derive a one-line preview of `input` for the named tool. The name is
 *  normalized here (`claude:Bash` -> `bash`), so hosts pass whatever name the
 *  log carries. Returns `''` when the tool isn't one of the ones with a known
 *  preview field — callers fall back to their own host-specific default (a
 *  generic key search, or nothing at all). */
export function deriveToolInputPreview(
  toolName: string,
  input: unknown,
): string {
  if (!isObject(input)) return '';
  const name = normalizeToolName(toolName);
  if (name === 'executions') return executionsInputPreview(input);
  if (name === 'delegate_multi_agents') {
    const script = typeof input.script === 'string' ? input.script : '';
    const workflowName = script.match(/\bname\s*:\s*(['"])(?<name>.*?)\1/)
      ?.groups?.name;
    if (workflowName) return workflowName;
    return typeof input.scriptPath === 'string' ? input.scriptPath : '';
  }
  const key = TOOL_PREVIEW_INPUT_KEY[name];
  if (!key) return '';
  const value = input[key];
  return typeof value === 'string' ? value : '';
}
