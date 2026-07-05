// Local imports - registry (type-only: keeps this module free of the
// registry's concrete tool-class dependencies so it stays cheap to bundle
// into either frontend).
import type { RegisteredToolName } from './registry';

/**
 * Structural "kind" of a tool's UI treatment, shared by every host that
 * renders individual tool calls: the CLI chat TUI
 * (`packages/cli/src/chat/tui/panes/toolRenderers.tsx`) and the VS Code
 * progress view
 * (`packages/extension/src/progressView/frontend/formatters/`).
 *
 * Both hosts used to hardcode their own tool-name lists for this and had
 * quietly drifted apart — neither referenced the actual tool registry, and
 * each recognized tool names the other didn't (issue #7120). This module is
 * the single source of truth: a tool-name -> kind lookup co-located with
 * `./registry.ts`, the canonical tool factory, so a renamed or removed
 * registered tool is caught here at compile time.
 */
export type ToolDisplayKind = 'edit' | 'read' | 'write' | 'bash';

/**
 * Non-registered tool names that still need a display kind:
 *  - `str_replace_based_edit_tool` is Anthropic's native tool-use name for
 *    the text-editor tool (see `TextEditorTool.ts`'s `API_TYPE_TO_NAME`) and
 *    surfaces verbatim in some tool-use entries instead of our canonical
 *    `str_replace_editor`.
 */
type KnownToolName = RegisteredToolName | 'str_replace_based_edit_tool';

/**
 * Tool name -> display kind, for the tools whose display treatment isn't the
 * generic fallback (a labeled input/output block):
 *  - `edit`: shows an old/new diff instead of the raw input.
 *  - `read`: shows a file link instead of the raw input/output.
 *  - `write`: shows a file link plus syntax-highlighted content.
 *  - `bash`: shows a shell-style command/output block.
 */
export const TOOL_DISPLAY_KIND: Partial<
  Record<KnownToolName, ToolDisplayKind>
> = {
  edit_file: 'edit',
  str_replace_editor: 'edit',
  str_replace_based_edit_tool: 'edit',

  read_file: 'read',

  write_file: 'write',

  bash: 'bash',
};

/** Look up a tool's display kind by its exact (canonical or native) name.
 *  Returns `undefined` for tools that use the generic display treatment. */
export function toolDisplayKind(toolName: string): ToolDisplayKind | undefined {
  return TOOL_DISPLAY_KIND[toolName as KnownToolName];
}
