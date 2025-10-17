// Local imports - agent
import type { AgentPrompt } from '@agent/core/AgentDataclass';

export interface NormalizedAgentPrompts {
  initialRequest: string;
  reflectionPrompts: string[];
}

function toArray(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => entry ?? '');
  }

  if (typeof value === 'string') {
    return [value];
  }

  return [];
}

function isNonEmptyTemplate(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function normalizeAgentPrompts(
  prompt: Pick<AgentPrompt, 'userRequest' | 'userReflect'>,
): NormalizedAgentPrompts {
  const requestEntries = toArray(prompt.userRequest);

  let initialRequest = '';
  let reflectionStartIndex = 0;

  for (let index = 0; index < requestEntries.length; index += 1) {
    const candidate = requestEntries[index];
    if (isNonEmptyTemplate(candidate)) {
      initialRequest = candidate;
      reflectionStartIndex = index + 1;
      break;
    }
  }

  if (!initialRequest && requestEntries.length > 0) {
    // All entries were empty strings; treat the first one as the initial request.
    initialRequest = requestEntries[0] ?? '';
    reflectionStartIndex = Math.min(1, requestEntries.length);
  }

  const reflectionsFromRequest = requestEntries
    .slice(reflectionStartIndex)
    .filter(isNonEmptyTemplate);

  const reflections =
    reflectionsFromRequest.length > 0
      ? reflectionsFromRequest
      : toArray(prompt.userReflect).filter(isNonEmptyTemplate);

  return {
    initialRequest,
    reflectionPrompts: reflections,
  };
}
