/**
 * Structural "kind" of a tool's UI treatment, shared by every host that
 * renders individual tool calls: the CLI chat TUI
 * (`packages/cli/src/chat/tui/panes/toolRenderers.tsx`) and the VS Code
 * progress view
 * (`packages/extension/src/progressView/frontend/formatters/`).
 *
 * Both hosts used to hardcode their own tool-name lists for this and had
 * quietly drifted apart. This browser-safe module is the single source of
 * truth. The tool registry checks its canonical mapped keys at compile time,
 * so a renamed or removed registered tool is caught without introducing a
 * shared-to-tools dependency.
 */
import { normalizeToolName } from './toolDisplayName';

export type ToolDisplayKind = 'edit' | 'read' | 'write' | 'bash';

/**
 * Tool name -> display kind, for the tools whose display treatment is not the
 * generic fallback (a labeled input/output block):
 *  - `edit`: shows an old/new diff instead of the raw input.
 *  - `read`: shows a file link instead of the raw input/output.
 *  - `write`: shows a file link plus syntax-highlighted content.
 *  - `bash`: shows a shell-style command/output block.
 */
const TOOL_DISPLAY_KIND = {
  edit_file: 'edit',
  str_replace_editor: 'edit',

  read_file: 'read',

  write_file: 'write',

  bash: 'bash',
} as const satisfies Readonly<Record<string, ToolDisplayKind>>;

/** Canonical mapped keys that must remain present in the tool registry. */
export type CanonicalToolDisplayName = keyof typeof TOOL_DISPLAY_KIND;

/** Look up a tool's display kind. The name is normalized first, so a
 *  provider-namespaced name from a delegated sub-agent (`claude:Bash`) or an
 *  MCP-wrapped one (`mcp:terminal/bash`) gets the same treatment as the
 *  canonical name it wraps. Returns `undefined` for tools that use the
 *  generic display treatment. Guarded with `Object.hasOwn` so an arbitrary
 *  tool name (e.g. `toString`, `__proto__`) cannot resolve to an inherited
 *  `Object.prototype` member. */
export function toolDisplayKind(toolName: string): ToolDisplayKind | undefined {
  const key = normalizeToolName(toolName) as keyof typeof TOOL_DISPLAY_KIND;
  return Object.hasOwn(TOOL_DISPLAY_KIND, key)
    ? TOOL_DISPLAY_KIND[key]
    : undefined;
}

/** True for tools whose input renders as an old/new diff. Beyond the exact
 *  `edit` display-kind names above: a delegated Claude Code sub-agent reports
 *  its own built-in tool names (`edit`, `multiedit`) verbatim, and some
 *  provider tool-use variants carry a `str_replace`/`text_editor` substring
 *  instead of one of the exact names. This is the single edit-classification
 *  entry point so every host's diff treatment matches. */
export function isEditLikeToolName(toolName: string): boolean {
  if (toolDisplayKind(toolName) === 'edit') return true;
  const name = normalizeToolName(toolName);
  return (
    name === 'edit' ||
    name === 'multiedit' ||
    name.includes('str_replace') ||
    name.includes('text_editor')
  );
}
