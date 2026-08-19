import { isJsonRecord, type JsonRecord } from './json.ts';
import { isGpt5Model } from './modelNames.ts';

export interface ReasoningEffortCapContext {
  provider: string;
  tier: string;
  modelName: string | null;
  tierCaps: Record<string, ReasoningEffortCap>;
}

export type ReasoningEffortCap = 'high' | 'medium';

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
  const cappedEffort = context.tierCaps[context.tier] ?? null;
  if (
    context.provider !== 'openai' ||
    !cappedEffort ||
    !isGpt5Model(context.modelName) ||
    !isJsonRecord(requestBody)
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
    isJsonRecord(requestBody.reasoning) &&
    requestBody.reasoning.effort === 'xhigh'
  ) {
    nextBody().reasoning = {
      ...requestBody.reasoning,
      effort: cappedEffort,
    };
  }

  return cappedBody ?? requestBody;
}
