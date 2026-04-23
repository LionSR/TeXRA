// Local imports - shared schemas and types
import type {
  AgentOptionData,
  SessionContextValue,
  SessionHintKey,
  SessionType,
} from '@shared/schemas';

// Local imports - main view
import { SESSION_TYPES } from './constants';

type SessionHintCopy = {
  lede: string;
  body: string;
  time: string;
  ariaLabel: string;
};

export const SESSION_HINT_COPY: Record<SessionHintKey, SessionHintCopy> = {
  workflow: {
    lede: 'Deep pass.',
    body: 'Drafts, reviews its own work, then revises — across your whole document.',
    time: 'Typically 5–10 min on fast models, 10–30 min on frontier reasoning. Pick a smaller model if you need faster turnaround.',
    ariaLabel: 'About workflow mode',
  },
  toolUse: {
    lede: 'Conversational.',
    body: 'Reads, edits, and searches in a running dialogue you steer turn by turn.',
    time: 'Turns stream back in seconds; tool-heavy runs take a minute or two. Pick a stronger model for longer chains of reasoning.',
    ariaLabel: 'About interactive mode',
  },
  orchestrator: {
    lede: 'Orchestrator.',
    body: 'Plans a pipeline of specialized agents and dispatches them for you.',
    time: 'Name specific agents in your instruction (e.g., “use polish on the intro, then review the math”) to steer delegation — otherwise it picks. Approve tasks in Progress as they arrive.',
    ariaLabel: 'About orchestrator mode',
  },
};

function isOrchestratorAgent(
  options: AgentOptionData[],
  selectedValue: string,
): boolean {
  return (
    options.find((option) => option.value === selectedValue)?.isOrchestrator ===
    true
  );
}

export function resolveSessionHintKey(
  session: Pick<
    SessionContextValue,
    'sessionType' | 'toolUseAgentOptions' | 'toolUseAgent'
  >,
): SessionHintKey {
  if (
    session.sessionType === SESSION_TYPES.TOOL_USE &&
    isOrchestratorAgent(session.toolUseAgentOptions, session.toolUseAgent)
  ) {
    return 'orchestrator';
  }

  return session.sessionType;
}

export function getSessionTitle(type: SessionType): string {
  const copy = SESSION_HINT_COPY[type];
  return `${copy.lede} ${copy.body}`;
}
