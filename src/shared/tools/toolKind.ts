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
export type ToolDisplayKind = 'edit' | 'read' | 'write' | 'bash';

/**
 * Tool name -> display kind, for the tools whose display treatment is not the
 * generic fallback (a labeled input/output block):
 *  - `edit`: shows an old/new diff instead of the raw input.
 *  - `read`: shows a file link instead of the raw input/output.
 *  - `write`: shows a file link plus syntax-highlighted content.
 *  - `bash`: shows a shell-style command/output block.
 *
 * `str_replace_based_edit_tool` is Anthropic's native tool-use alias for the
 * text-editor tool. It can surface verbatim instead of the canonical
 * `str_replace_editor`, but it is not a registered TeXRA tool name.
 */
const TOOL_DISPLAY_KIND = {
  edit_file: 'edit',
  str_replace_editor: 'edit',
  str_replace_based_edit_tool: 'edit',

  read_file: 'read',

  write_file: 'write',

  bash: 'bash',
} as const satisfies Readonly<Record<string, ToolDisplayKind>>;

/** Canonical mapped keys that must remain present in the tool registry. */
export type CanonicalToolDisplayName = Exclude<
  keyof typeof TOOL_DISPLAY_KIND,
  'str_replace_based_edit_tool'
>;

/** Look up a tool's display kind by its exact canonical or native name.
 *  Returns `undefined` for tools that use the generic display treatment.
 *  Guarded with `Object.hasOwn` so an arbitrary tool name (e.g. `toString`,
 *  `__proto__`) cannot resolve to an inherited `Object.prototype` member. */
export function toolDisplayKind(toolName: string): ToolDisplayKind | undefined {
  const key = toolName as keyof typeof TOOL_DISPLAY_KIND;
  return Object.hasOwn(TOOL_DISPLAY_KIND, key)
    ? TOOL_DISPLAY_KIND[key]
    : undefined;
}
