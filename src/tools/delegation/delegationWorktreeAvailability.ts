/**
 * Live "Git worktree support:" annotation for the delegate_agent description.
 *
 * Worktree support is a workspace setting the user can toggle after the tool
 * registry is built, so — like the models and agents lines — the advisory text
 * is resolved per run at the `resolveAgentTools` boundary rather than frozen
 * into the tool definition when the registry was first constructed. The
 * schema's `working_directory` field already enforces the real state at
 * validation time; this only keeps the description's guidance in step with it.
 *
 * Unlike the roster annotation, this one is replace-only: a tool without a
 * "Git worktree support:" line (e.g. delegate_workflow, which has no
 * working_directory) takes no working directory, so a line must never be
 * appended to it.
 */

import type { ToolDefinition } from '@model/ToolDefinition';
import { isWorktreeSupportEnabled } from '@utils/config/worktreeConfig';
import { replaceDelegationDescriptionBlock } from './delegationDescriptionBlock';

/** The single "Git worktree support:" line, anchored to a line start. */
const WORKTREE_LINE = /^Git worktree support:.*$/m;

const WORKTREE_ENABLED_LINE =
  'Git worktree support: ENABLED. Pass `working_directory` (absolute path) to run a subagent rooted in a git worktree; every tool call in the subagent resolves paths against that directory. The subagent reports its working directory back in its delivery result.';

const WORKTREE_DISABLED_LINE =
  'Git worktree support: DISABLED in this workspace. Do not pass `working_directory` because it will be rejected at schema validation. Ask the user to turn on `texra.git.worktreeSupport` ("Allow agents to work in git worktrees" on the Multi-Agent settings tab) if worktree operation is needed.';

/**
 * Replace the "Git worktree support:" line of a delegation tool's description
 * with the line for the current workspace setting. Tools without that line
 * (and non-delegation tools, and tools without a description) are returned
 * untouched, and the worktree setting is read only when the line is present.
 */
export function withDelegationWorktreeAvailability(
  tool: ToolDefinition,
): ToolDefinition {
  // Replace-only: a tool with no "Git worktree support:" line takes no
  // `working_directory`, so the line must never be appended. The setting is
  // read lazily, only when the anchor is present.
  return replaceDelegationDescriptionBlock(
    tool,
    WORKTREE_LINE,
    () =>
      isWorktreeSupportEnabled()
        ? WORKTREE_ENABLED_LINE
        : WORKTREE_DISABLED_LINE,
    { appendIfMissing: false },
  );
}
