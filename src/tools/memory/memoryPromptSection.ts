/**
 * The memory plugin's prompt section: the memory protocol while the step
 * offers `memory`, with the orchestrator's variant when it offers a
 * delegation tool too, or the subagent's in a child run. A step pins it with
 * the plugin (`@agent/runtime/loop/step`), so it follows the tool switched
 * on or off mid-conversation, and the recorded offered set rebuilds it.
 */
import { hasDelegationTool } from '@shared/constants/delegationTools';
import type { PromptSection } from '@tools/toolTable';

/** Base memory instructions for all agents with memory enabled. */
const MEMORY_TOOL_INSTRUCTIONS = `<memory_tool_instructions>
Pinned memories are always loaded unless the user forbids memory use. At session start, \`view\` the \`/memories\` directory to find entries marked [pinned]. If the listing is truncated, continue until you have seen every [pinned] entry. Then \`view\` each pinned file so its content applies, regardless of how self-contained the request looks. Pinned entries are the core reusable insights (techniques, strategies, pitfalls) accumulated across sessions. The directory listing alone does not load their content. Beyond pinned entries, use memory when the request may depend on prior sessions, durable user preferences, or shared agent context. For a self-contained request, do not read unpinned memory files or write memory merely because the tool is available. Listing the directory is still appropriate because it is needed to find pinned entries.

Your memory persists across conversations. When memory is in play, record durable progress, decisions, and user preferences (writing style, conventions, formatting, workflow). Keep the folder current and organized by updating, renaming, or deleting files rather than duplicating them. Do not store what the workspace files already state. When project context, coding patterns, or conventions are relevant to the task and git is available, look into git history (commit messages, PR descriptions, recent changes) to understand them. Use \`pin\` only for long-term reusable insights, never task-specific progress notes. Use \`unpin\` for entries that no longer earn their place.
</memory_tool_instructions>`;

/** Memory instructions for orchestrators that launch subagents. */
const ORCHESTRATOR_MEMORY_INSTRUCTIONS = `<orchestrator_memory_protocol>
The /memories directory is shared with all subagents you launch. Subagents can read and write the same files. Use this for persistent context that should survive across conversations. Do not use it as a substitute for subagent result delivery because subagents report back automatically via follow-up messages. Good uses include project conventions, user preferences, and research bibliographies that build up over time.

For continuation or delegation-heavy work, consult relevant memories instead of rediscovering context. Record reusable intelligence: what approaches worked or failed and why, project structure and conventions you discovered, user preferences revealed through corrections or rejections, and effective problem-solving strategies.
</orchestrator_memory_protocol>`;

/** Memory instructions for subagents launched by an orchestrator. */
const SUBAGENT_MEMORY_INSTRUCTIONS = `<subagent_memory_protocol>
The /memories directory is shared with the orchestrator and other subagents. Check it when your delegated task may depend on context from prior sessions or sibling agents. Write to memory for information that should persist beyond this session (e.g., discovered conventions, useful references). Your primary results should go in your response, not in memory.
</subagent_memory_protocol>`;

export const memoryPromptSection: PromptSection = ({ offered, isChild }) => {
  if (!offered.includes('memory')) return '';
  const parts = [MEMORY_TOOL_INSTRUCTIONS];
  if (hasDelegationTool(offered)) parts.push(ORCHESTRATOR_MEMORY_INSTRUCTIONS);
  else if (isChild) parts.push(SUBAGENT_MEMORY_INSTRUCTIONS);
  return parts.join('\n');
};
