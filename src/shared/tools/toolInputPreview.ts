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
  delegate_agent: 'agent',
  delegate_workflow: 'agent',
};

/** Input keys that name what a call is acting on, for tools with no entry of
 *  their own. Scanned in order, so a call carrying both a command and a path
 *  is described by the command. */
const GENERIC_PREVIEW_INPUT_KEYS: readonly string[] = [
  'command',
  'code',
  'path',
  'file_path',
  'query',
  'url',
];

/** Derive a one-line preview of `input` for the named tool. The name is
 *  normalized here (`claude:Bash` -> `bash`), so hosts pass whatever name the
 *  log carries. Falls back to a generic scan of the keys that name a call's
 *  target, and returns `''` only when the input names nothing — never a raw
 *  `JSON.stringify` of the whole input, which is what the CLI used to show
 *  for every delegation call. */
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
  if (key) {
    const value = input[key];
    if (typeof value === 'string' && value) return value;
  }
  for (const generic of GENERIC_PREVIEW_INPUT_KEYS) {
    const value = input[generic];
    if (typeof value === 'string' && value) return value;
  }
  return '';
}
