import type { ExecutionRegistry } from '@agent/runtime/executionRegistry';
import type {
  ClaudeAgentEffort,
  ClaudeAgentPermissionMode,
  ExecutionId,
  StreamTabId,
} from '@shared/schemas';

import { AgentCliSessionRegistry } from './agentCliSessionRegistry';
import type { Thread } from '@openai/codex-sdk';

export interface ActiveCodexThread {
  thread: Thread;
  childStreamId: StreamTabId;
  parentStreamId: StreamTabId;
  executionId: ExecutionId;
  executions: ExecutionRegistry;
}

export interface ActiveClaudeAgentSession {
  childStreamId: StreamTabId;
  parentStreamId: StreamTabId;
  executionId: ExecutionId;
  executions: ExecutionRegistry;
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
