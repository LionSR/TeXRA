export interface ReasoningEffortCapContext {
  provider: string;
  tier: string;
  modelName: string | null;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isGpt5Model(modelName: string | null): boolean {
  if (!modelName) return false;

  const normalized = modelName.toLowerCase().trim();
  const modelPart = normalized.includes('/')
    ? normalized.slice(normalized.indexOf('/') + 1)
    : normalized;

  return modelPart.startsWith('gpt-5') || modelPart.startsWith('gpt5');
}

function capForTier(tier: string): 'high' | 'medium' | null {
  if (tier === 'Max') return 'high';
  if (tier === 'free') return 'medium';
  return null;
}

/**
 * Apply the relay-side GPT-5 reasoning cap for included-access requests.
 *
 * The extension applies the same cap before it calls the relay. This helper
 * enforces the policy at the server boundary as well, so direct relay callers
 * cannot bypass it by sending `xhigh` manually.
 */
export function capOpenAIReasoningEffortForTier(
  requestBody: unknown,
  context: ReasoningEffortCapContext,
): unknown {
  const cappedEffort = capForTier(context.tier);
  if (
    context.provider !== 'openai' ||
    !cappedEffort ||
    !isGpt5Model(context.modelName) ||
    !isRecord(requestBody)
  ) {
    return requestBody;
  }

  let cappedBody: JsonRecord | null = null;
  const nextBody = () => {
    cappedBody ??= { ...requestBody };
    return cappedBody;
  };

  if (requestBody.reasoning_effort === 'xhigh') {
    nextBody().reasoning_effort = cappedEffort;
  }

  if (
    isRecord(requestBody.reasoning) &&
    requestBody.reasoning.effort === 'xhigh'
  ) {
    nextBody().reasoning = {
      ...requestBody.reasoning,
      effort: cappedEffort,
    };
  }

  return cappedBody ?? requestBody;
}
