interface MoonshotRequestRule {
  /** `undefined` means Moonshot requires the field to be omitted. */
  readonly temperature: (supportsReasoning: boolean) => number | undefined;
  readonly disableThinkingInCompactionSummary?: boolean;
}

/**
 * Sampling constraints keyed by Moonshot's API wire name. These apply to
 * direct requests and to requests forwarded through OpenRouter.
 */
const KIMI_K27_CODE_RULE: MoonshotRequestRule = {
  temperature: () => 1,
  disableThinkingInCompactionSummary: true,
};

const KIMI_K3_RULE: MoonshotRequestRule = {
  temperature: () => undefined,
  disableThinkingInCompactionSummary: true,
};

const REQUEST_RULES_BY_FULL_NAME: ReadonlyMap<string, MoonshotRequestRule> =
  new Map([
    [
      'kimi-k2.5',
      {
        temperature: (supportsReasoning: boolean) =>
          supportsReasoning ? 1 : 0.6,
      },
    ],
    ['kimi-k2.7-code', KIMI_K27_CODE_RULE],
    ['kimi-for-coding', KIMI_K27_CODE_RULE],
    ['kimi-for-coding-highspeed', KIMI_K27_CODE_RULE],
    ['kimi-k3', KIMI_K3_RULE],
    ['k3', KIMI_K3_RULE],
  ]);

export interface MoonshotRequestParameters {
  readonly temperature: number | undefined;
  readonly disableThinkingInCompactionSummary: boolean;
}

/** Return Moonshot-specific parameters, or undefined for an unconstrained model. */
export function resolveMoonshotRequestParameters(
  fullName: string,
  supportsReasoning: boolean,
): MoonshotRequestParameters | undefined {
  const rule = REQUEST_RULES_BY_FULL_NAME.get(fullName);
  if (!rule) return undefined;
  return {
    temperature: rule.temperature(supportsReasoning),
    disableThinkingInCompactionSummary:
      rule.disableThinkingInCompactionSummary ?? false,
  };
}
