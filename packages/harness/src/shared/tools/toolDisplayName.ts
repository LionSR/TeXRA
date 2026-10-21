/**
 * Tool-name normalization and display labels, shared by every host that
 * renders individual tool calls.
 *
 * A tool name reaches a renderer in three shapes: the canonical registry name
 * (`bash`), a provider-namespaced name from a delegated sub-agent
 * (`claude:Edit`), and an MCP tool's name: the harness's own
 * (`mcp__<server>__<tool>`) or the one a plugin reports for an external
 * agent's MCP call (`mcp:<server>/<tool>`, built by `buildMcpToolName`).
 * This browser-safe module is the single source of truth for both halves: the canonical lookup key and the
 * label a user sees.
 */

/** Friendly labels for tool names that shouldn't be shown verbatim, keyed by
 *  normalized name. */
const TOOL_LABEL = new Map<string, string>([['agent', 'Agent']]);

const MCP_PREFIX = 'mcp:';
const MCP_TOOL_PREFIX = 'mcp__';

/** The `<server>/<tool>` an MCP tool's name carries, in either shape (the
 *  harness's under a sub-agent's `claude:` prefix too), or null for any
 *  other tool. */
function mcpServerTool(toolName: string): string | null {
  if (toolName.startsWith(MCP_PREFIX)) return toolName.slice(MCP_PREFIX.length);
  const name = toolName.slice(toolName.lastIndexOf(':') + 1);
  if (!name.startsWith(MCP_TOOL_PREFIX)) return null;
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const cut = rest.indexOf('__');
  return cut > 0 ? `${rest.slice(0, cut)}/${rest.slice(cut + 2)}` : null;
}

/** True for an MCP tool call: the harness's `mcp__<server>__<tool>` or an
 *  external agent's `mcp:<server>/<tool>`. */
export function isMcpToolName(toolName: string): boolean {
  return mcpServerTool(toolName) !== null;
}

/** Build the `mcp:<server>/<tool>` wire name for an MCP tool call. Single
 *  source of the `mcp:` contract so a plugin reporting an external agent's
 *  MCP call and the recognition/display side here can't drift: if the producer used its own literal, a drift would silently make
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
  const mcp = mcpServerTool(toolName);
  if (mcp !== null) return `MCP ${mcp}`;
  const segment = lastNameSegment(toolName);
  const label = TOOL_LABEL.get(segment.toLowerCase()) ?? segment;
  return label || 'tool';
}
