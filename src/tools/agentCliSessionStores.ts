import { Context, Effect, Layer } from 'effect';

import { Runs } from '@agent/runtime/runRegistry';

import { AgentCliSessionRegistry } from './agentCliSessionRegistry';

/**
 * The codex and claude-agent plugins' session services
 * (`PLUGIN_SESSION_LAYERS`): each session's registry of that agent CLI's
 * live sessions, over the session's own `Runs`, so a registry dies with its
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

const registryOver = Effect.map(
  Runs,
  (runs) => new AgentCliSessionRegistry(runs),
);

export const codexThreadsLayer = Layer.effect(CodexThreads, registryOver);

export const claudeAgentSessionsLayer = Layer.effect(
  ClaudeAgentSessions,
  registryOver,
);
