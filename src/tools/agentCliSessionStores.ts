import type {
  ClaudeAgentEffort,
  ClaudeAgentPermissionMode,
} from '@shared/schemas';

import {
  AgentCliSessionRegistry,
  type AgentCliSessionEntry,
} from './agentCliSessionRegistry';
import type { Thread } from '@openai/codex-sdk';

export interface ActiveCodexThread extends AgentCliSessionEntry {
  thread: Thread;
}

export interface ActiveClaudeAgentSession extends AgentCliSessionEntry {
  model: string;
  permissionMode: ClaudeAgentPermissionMode;
  effort: ClaudeAgentEffort;
  cwd?: string;
  additionalDirectories?: string[];
}

export const CodexThreads = new AgentCliSessionRegistry<ActiveCodexThread>(
  'codex_thread_id',
);

export const ClaudeAgentSessions =
  new AgentCliSessionRegistry<ActiveClaudeAgentSession>(
    'claude_agent_session_id',
  );
