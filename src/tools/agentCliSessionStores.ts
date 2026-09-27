import { Context, Effect, Layer } from 'effect';

import { Runs } from '@agent/runtime/runRegistry';
import { PluginHold } from '@tools/toolTable';

import { AgentCliSessionRegistry } from './agentCliSessionRegistry';

/**
 * The codex and claude-agent plugins' session services
 * (`PLUGIN_SESSION_LAYERS`): each session's registry of that agent CLI's
 * live sessions, over the session's own `Runs`, so a registry dies with its
 * session instead of living as a process singleton. Each live child holds
 * its registry (`AgentCliSessionRegistry.holdWhileLive`), so switching the
 * plugin off and on while one runs keeps the registry that routes its
 * follow-ups.
 */
export class CodexThreads extends Context.Service<
  CodexThreads,
  AgentCliSessionRegistry
>()('@texra/tools/CodexThreads') {}

export class ClaudeAgentSessions extends Context.Service<
  ClaudeAgentSessions,
  AgentCliSessionRegistry
>()('@texra/tools/ClaudeAgentSessions') {}

const registryOver = Effect.gen(function* () {
  return new AgentCliSessionRegistry(yield* Runs, yield* PluginHold);
});

export const codexThreadsLayer = Layer.effect(CodexThreads, registryOver);

export const claudeAgentSessionsLayer = Layer.effect(
  ClaudeAgentSessions,
  registryOver,
);
