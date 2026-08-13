/**
 * Tool-name normalization and display labels, shared by every host that
 * renders individual tool calls: the CLI chat TUI
 * (`packages/cli/src/chat/tui/panes/toolRenderers.tsx`) and the VS Code
 * progress view
 * (`packages/extension/src/progressView/frontend/formatters/`).
 *
 * A tool name reaches a renderer in three shapes: the canonical registry name
 * (`bash`), a provider-namespaced name from a delegated sub-agent
 * (`claude:Edit`), and the MCP name TeXRA emits for a Codex MCP call
 * (`mcp:<server>/<tool>`, see `buildCodexMcpToolLog` in
 * `src/tools/codexShared.ts`). Normalization used to be host-local, so the
 * progress view showed a namespaced name verbatim and missed every
 * name-keyed display rule the CLI applied. This browser-safe module is the
 * single source of truth for both halves: the canonical lookup key and the
 * label a user sees.
 */

/** Friendly labels for tool names that shouldn't be shown verbatim, keyed by
 *  normalized name. */
const TOOL_LABEL = new Map<string, string>([
  ['delegate_multi_agents', 'Multi-agent workflow'],
  ['codex_patch', 'Codex Files'],
  ['codex_thread', 'Codex Thread'],
  ['codex_todo', 'Codex Plan'],
  ['codex_turn', 'Codex Turn'],
]);

const MCP_PREFIX = 'mcp:';

/** True for the `mcp:<server>/<tool>` names TeXRA emits for MCP tool calls. */
export function isMcpToolName(toolName: string): boolean {
  return toolName.startsWith(MCP_PREFIX);
}

/** Build the `mcp:<server>/<tool>` wire name for an MCP tool call. Single
 *  source of the `mcp:` contract so the producer (`buildCodexMcpToolLog` in
 *  `src/tools/codexShared.ts`) and the recognition/display side here can't
 *  drift: if the producer used its own literal, a drift would silently make
 *  `isMcpToolName` return false for every MCP call and names would render
 *  verbatim. */
export function buildMcpToolName(server: string, tool: string): string {
  return `${MCP_PREFIX}${server}/${tool}`;
}

/** Drop provider/handler and MCP namespaces: `claude:Edit` -> `Edit`,
 *  `mcp:terminal/bash` -> `bash`. Case is preserved for display. The `/` cut
 *  is deliberate MCP `server/tool` unwrapping, not general path splitting; no
 *  registry tool name contains a bare `/`. */
function lastNameSegment(toolName: string): string {
  const cut = Math.max(toolName.lastIndexOf(':'), toolName.lastIndexOf('/'));
  return cut >= 0 ? toolName.slice(cut + 1) : toolName;
}

/** Canonical lookup key for a tool name: namespaces stripped, lowercased.
 *  Every name-keyed display rule (`toolDisplayKind`,
 *  `deriveToolInputPreview`, icon and label maps) keys off this, so a
 *  namespaced name from a delegated sub-agent gets the same treatment as the
 *  registry name it wraps. */
export function normalizeToolName(toolName: string): string {
  return lastNameSegment(toolName).toLowerCase();
}

/** Label for a tool row header. MCP calls keep their `server/tool`
 *  provenance; everything else shows its friendly label, or the namespace
 *  stripped name when it has none. */
export function displayToolName(toolName: string): string {
  if (isMcpToolName(toolName)) {
    return `MCP ${toolName.slice(MCP_PREFIX.length)}`;
  }
  const segment = lastNameSegment(toolName);
  const label = TOOL_LABEL.get(segment.toLowerCase()) ?? segment;
  return label || 'tool';
}
