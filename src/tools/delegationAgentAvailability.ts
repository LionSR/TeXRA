/**
 * Live "Available agents:" annotation for delegation tool descriptions.
 *
 * The delegate_agent / delegate_workflow descriptions ship with a placeholder
 * "Available agents:" line. The real roster is the set of agents currently
 * visible for the tool's category, which can change after the tool registry is
 * constructed (the user toggles visibility, or a multi-agent preset swaps the
 * roster mid-session). So the list is resolved per run here — the same contract
 * `delegationModelAvailability` uses for the "Available models:" line — instead
 * of being frozen into the registry's tool definition at first access.
 *
 * Keeping this current is what lets the agent-native delegation convention work:
 * delegating agents (orchestrator, engineer, …) are told to pick from the
 * tool description's "Available agents" list, so a stale list made them attempt
 * agents that are no longer in the roster and discover the mismatch only via a
 * failed delegate call.
 */

import {
  getAgent,
  getAgentsByCategory,
  getVisibleAgent as getWorkspaceVisibleAgent,
  getVisibleAgents,
  type AgentEntry,
} from '@agent/index/agentRegistry';
import { tryUseRunContext } from '@agent/runtime/RunContext';
import type { ToolDefinition } from '@model';
import type { AgentCategory } from '@shared/schemas/agent';
import { agentName } from '@shared/schemas/agent';
import { replaceDelegationDescriptionBlock } from '@tools/delegationDescriptionBlock';

/** Matches the "Available agents:" header plus its contiguous (non-blank) list
 * lines, stopping at the first blank line or end of string. Anchored to a line
 * start so it can't match the substring inside surrounding prose. Terminating on
 * a non-blank run (rather than a `(?=\n\n)` lookahead) means a block at the very
 * end of a description still matches, so it is replaced rather than duplicated. */
const AVAILABLE_AGENTS_BLOCK = /^Available agents:.*(?:\n(?!\n).+)*/m;

const NO_AGENTS_LINE =
  'Available agents: none are currently in the active roster — ask the user to enable delegation targets in Settings → Agents before delegating.';

/** Format an agent list for tool descriptions. Newlines inside a description
 * are collapsed to single spaces so each agent stays one paragraph — a blank
 * line in a (e.g. user- or remote-defined) description would otherwise look
 * like the end of the "Available agents:" block to a reader or the block
 * regex. */
export function formatAgentList(
  agents: { name: string; description?: string; tools?: string[] }[],
): string {
  return agents
    .map((agent) => {
      const desc = (agent.description || 'No description').replaceAll(
        /\s*\n\s*/g,
        ' ',
      );
      const toolsSuffix = agent.tools?.length
        ? `\n  Tools: ${agent.tools.join(', ')}`
        : '';
      return `- ${agent.name}: ${desc}${toolsSuffix}`;
    })
    .join('\n');
}

/**
 * Build the "Available agents:" block for a delegation tool's category from the
 * currently visible roster. An empty roster yields a single actionable line
 * rather than a bare header, mirroring the empty-state messaging on the models
 * line. The only caller, `resolveAgentTools`, runs inside an agent flow that
 * has already loaded the registry, so an empty result means the user genuinely
 * has no visible agents in this category — not a not-yet-loaded cache.
 */
export function visibleDelegationAgentsBlock(category: AgentCategory): string {
  const agents = getDelegationAgents(category);
  if (agents.length === 0) return NO_AGENTS_LINE;
  return `Available agents:\n${formatAgentList(agents)}`;
}

/** Resolve delegation targets from the active run scope, then durable roster. */
export function getDelegationAgents(category: AgentCategory): AgentEntry[] {
  const context = tryUseRunContext();
  const scope =
    context?.kind === 'launch'
      ? context.runScope.delegationAgentScope
      : undefined;
  if (!scope) return getVisibleAgents(category);
  const keys =
    category === 'workflow' ? scope.workflowAgentKeys : scope.toolUseAgentKeys;
  const names = new Set(keys.map((key) => key.split(':').at(-1) ?? key));
  return getAgentsByCategory(category).filter((entry) => names.has(entry.name));
}

export function getDelegationAgent(
  category: AgentCategory,
  identifier: string,
): AgentEntry | undefined {
  const context = tryUseRunContext();
  const scope =
    context?.kind === 'launch'
      ? context.runScope.delegationAgentScope
      : undefined;
  if (!scope) return getWorkspaceVisibleAgent(category, identifier);
  const resolvedName =
    getAgent(identifier, category)?.name ?? agentName(identifier);
  return getDelegationAgents(category).find(
    (entry) => entry.name === resolvedName,
  );
}

/**
 * Replace the "Available agents:" block in a delegation tool's description with
 * the supplied block, appending it when the description has no such block yet.
 * A `$` in an agent description (e.g. inline LaTeX math) stays literal.
 */
export function withDelegationAgentAvailability(
  tool: ToolDefinition,
  agentsBlock: string,
): ToolDefinition {
  return replaceDelegationDescriptionBlock(
    tool,
    AVAILABLE_AGENTS_BLOCK,
    agentsBlock,
    {
      appendIfMissing: true,
    },
  );
}
