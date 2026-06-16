import type { AgentEntry } from '@agent/index';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';

const AGENT_LOOKUP_HINT =
  'Use `texra agents list` for visible starter agents, or pass a known launchable agent name from a team preset.';
const MULTI_AGENT_PRESET_LOOKUP_HINT =
  'Use `texra multi-agent list` for available team presets, then run `texra multi-agent inspect <preset>` to check a team before launch.';

type CliAgentLaunchMode = 'chat' | 'run' | 'agentsRun';

type CliAgentLaunchValidation =
  | { readonly ok: true; readonly agent: AgentEntry }
  | { readonly ok: false; readonly error: string };

const CLI_AGENT_LAUNCH_TARGETS = {
  chat: {
    category: AgentCategory.ToolUse,
    missing: missingToolUseAgentMessage,
    mismatch: (name: string, actual: AgentEntry['category']) =>
      `Agent "${name}" is a ${actual} agent; \`texra chat\` only handles tool-use agents. Use \`texra run ${name}\` for workflow agents, or \`texra multi-agent run <preset>\` for teams.`,
  },
  run: {
    category: AgentCategory.Workflow,
    missing: missingAgentMessage,
    mismatch: (name: string, actual: AgentEntry['category']) =>
      `Agent "${name}" is a ${actual} agent; \`texra run\` only handles workflow agents. Start it interactively with \`texra chat --agent ${name}\`, or run a headless team with \`texra multi-agent run\`.`,
  },
  agentsRun: {
    category: AgentCategory.ToolUse,
    missing: missingToolUseAgentMessage,
    mismatch: (name: string, actual: AgentEntry['category']) =>
      `Agent "${name}" is a ${actual} agent; \`texra agents run\` only handles tool-use agents. Use \`texra run ${name}\` for workflow agents.`,
  },
} as const;

export const AGENT_NAME_DESCRIPTION =
  'Agent name from `texra agents list` or a known launchable agent name';

export const TOOL_USE_AGENT_NAME_DESCRIPTION =
  'Tool-use agent name from `texra agents list` or a known launchable agent name';

export function missingAgentMessage(name: string): string {
  return `Agent not found: ${name}. ${AGENT_LOOKUP_HINT}`;
}

export function missingToolUseAgentMessage(name: string): string {
  return `Tool-use agent not found: ${name}. ${AGENT_LOOKUP_HINT}`;
}

export function missingMultiAgentPresetMessage(name: string): string {
  return `Multi-agent preset not found: ${name}. ${MULTI_AGENT_PRESET_LOOKUP_HINT}`;
}

export function cliAgentLaunchCategory(
  mode: CliAgentLaunchMode,
): AgentCategory {
  return CLI_AGENT_LAUNCH_TARGETS[mode].category;
}

export function validateCliAgentLaunch(
  name: string,
  agent: AgentEntry | undefined,
  mode: CliAgentLaunchMode,
): CliAgentLaunchValidation {
  const target = CLI_AGENT_LAUNCH_TARGETS[mode];
  if (!agent) return { ok: false, error: target.missing(name) };
  if (agent.category !== target.category) {
    return { ok: false, error: target.mismatch(name, agent.category) };
  }
  return { ok: true, agent };
}
