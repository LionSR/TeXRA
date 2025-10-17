// Local imports - agent
import type { AgentPrompt } from '@agent/core/AgentDataclass';

export interface NormalizedAgentPrompts {
  initialRequest: string;
  reflectionPrompts: string[];
}

function toArray(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === 'string') {
    return [value];
  }

  return [];
}

export function normalizeAgentPrompts(
  prompt: Pick<AgentPrompt, 'userRequest'>,
): NormalizedAgentPrompts {
  const requestEntries = toArray(prompt.userRequest);

  const initialRequest = requestEntries[0] ?? '';
  const reflectionPrompts = requestEntries.slice(1);

  return {
    initialRequest,
    reflectionPrompts,
  };
}
