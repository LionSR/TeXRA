import { Context, Layer } from 'effect';

import { AgentCliSessionRegistry } from './agentCliSessionRegistry';

/**
 * The codex and claude-agent plugins' session services (their plugins'
 * `sessionLayer`): each session's registry of the threads that agent CLI
 * has a turn running on, one per session, so a registry dies with its
 * session instead of living as a process singleton.
 */
export class CodexThreads extends Context.Service<
  CodexThreads,
  AgentCliSessionRegistry
>()('@texra/tools/CodexThreads') {}

export class ClaudeAgentSessions extends Context.Service<
  ClaudeAgentSessions,
  AgentCliSessionRegistry
>()('@texra/tools/ClaudeAgentSessions') {}

export const codexThreadsLayer = Layer.sync(
  CodexThreads,
  () => new AgentCliSessionRegistry(),
);

export const claudeAgentSessionsLayer = Layer.sync(
  ClaudeAgentSessions,
  () => new AgentCliSessionRegistry(),
);
