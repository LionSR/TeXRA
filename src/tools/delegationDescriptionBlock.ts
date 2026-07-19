/**
 * Shared mechanics for the per-run "Available agents / models / worktree"
 * annotations injected into delegation tool descriptions.
 *
 * Each availability module (agents, models, worktree) owns its own anchor
 * pattern and copy; they all share the same injection contract: only touch
 * delegation tools that have a description, replace the matched block in place
 * (via a replacer function so a `$` in the replacement is never read as a
 * pattern token), and — for annotations that must default onto a description
 * with no anchor — append the block instead.
 */

// Local imports
import type { ToolDefinition } from '@model';
import { DELEGATION_TOOLS } from '@shared/constants/delegationTools';

/**
 * Replace `pattern`'s match in a delegation tool's description with
 * `replacement`, returning a new definition. Non-delegation tools and tools
 * without a description are returned untouched.
 *
 * When the pattern does not match:
 *   - `appendIfMissing: true` appends the block as a trailing paragraph.
 *   - `appendIfMissing: false` leaves the description unchanged (replace-only,
 *     for annotations that must never be added where the anchor is absent).
 *
 * `replacement` may be a thunk so the caller can defer any config/registry read
 * until the tool is confirmed to need the block (matched, or appended).
 */
export function replaceDelegationDescriptionBlock(
  tool: ToolDefinition,
  pattern: RegExp,
  replacement: string | (() => string),
  { appendIfMissing }: { appendIfMissing: boolean },
): ToolDefinition {
  if (!DELEGATION_TOOLS.has(tool.name) || !tool.description) return tool;

  const matched = pattern.test(tool.description);
  if (!matched && !appendIfMissing) return tool;

  const text = typeof replacement === 'function' ? replacement() : replacement;
  const description = matched
    ? tool.description.replace(pattern, () => text)
    : `${tool.description}\n\n${text}`;
  return { ...tool, description };
}
