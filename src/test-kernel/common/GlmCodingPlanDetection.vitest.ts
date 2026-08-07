import { describe, expect, it } from 'vitest';

import {
  describeGlmCodingPlanLimit,
  formatProviderHttpError,
  parseGlmCodingPlanLimit,
} from '@common/errors/sdkErrorUtils';

const WEEKLY_LIMIT_BODY = {
  error: {
    code: '1310',
    message:
      'Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-08-14T00:00:00Z',
  },
} as const;

const FIVE_HOUR_LIMIT_BODY = {
  error: {
    code: '1316',
    message:
      'Usage limit reached for the past 5 hours. Insufficient balance for extra usage. Resets at 2026-08-07T05:00:00Z',
  },
} as const;

/** The real GLM Coding Plan error: a UTC+8 China-time reset timestamp. */
const CST_TIMESTAMP_BODY = {
  error: {
    code: '1308',
    message:
      '已达到 5 小时的使用上限。您的限额将在 2026-08-08 11:32:36 重置。',
  },
} as const;

describe('parseGlmCodingPlanLimit', () => {
  it('parses a GLM Coding Plan weekly-limit error', () => {
    expect(parseGlmCodingPlanLimit(WEEKLY_LIMIT_BODY)).not.toBeNull();
  });

  it('parses a GLM Coding Plan 5-hour-limit error', () => {
    expect(parseGlmCodingPlanLimit(FIVE_HOUR_LIMIT_BODY)).not.toBeNull();
  });

  it('parses the SDK-enveloped { error } form', () => {
    expect(
      parseGlmCodingPlanLimit({ error: WEEKLY_LIMIT_BODY.error }),
    ).not.toBeNull();
  });

  it('derives the reset window from a UTC+8 China-time timestamp in the message', () => {
    const limit = parseGlmCodingPlanLimit(CST_TIMESTAMP_BODY);
    expect(limit).not.toBeNull();
    // The reset timestamp is in the future, so a finite seconds count is set.
    expect(limit?.resetsInSeconds).toBeTypeOf('number');
    expect(limit?.resetsInSeconds).toBeGreaterThan(0);
  });

  it('ignores non-quota error codes', () => {
    expect(
      parseGlmCodingPlanLimit({
        error: { code: '1302', message: 'Rate limit reached' },
      }),
    ).toBeNull();
    expect(
      parseGlmCodingPlanLimit({
        error: { code: '1305', message: 'temporarily overloaded' },
      }),
    ).toBeNull();
    expect(
      parseGlmCodingPlanLimit({
        error: { code: '1113', message: 'Insufficient balance' },
      }),
    ).toBeNull();
  });

  it('ignores unrelated bodies', () => {
    expect(parseGlmCodingPlanLimit({ message: 'nope' })).toBeNull();
    expect(parseGlmCodingPlanLimit(undefined)).toBeNull();
  });

  it('formats a human-readable reset hint', () => {
    const text = describeGlmCodingPlanLimit({ resetsInSeconds: 3600 });
    expect(text).toContain('GLM Coding Plan usage limit');
    expect(text).toContain('regular GLM endpoint');
  });
});

describe('formatProviderHttpError for GLM Coding Plan limits', () => {
  it('classifies a GLM Coding Plan usage-limit error as a switchable credential exhaustion', () => {
    const error = new Error('Weekly/Monthly Limit Exhausted') as Error & {
      error: unknown;
      provider?: string;
    };
    error.error = WEEKLY_LIMIT_BODY;
    error.provider = 'glm';

    const providerError = formatProviderHttpError(error);

    expect(providerError.exhaustionReason).toBe('glm-coding-plan');
    expect(providerError.userRetryable).toBe(true);
    expect(providerError.message).toContain('GLM Coding Plan usage limit');
  });

  it('does not classify a GLM rate limit as a coding-plan exhaustion', () => {
    const error = new Error('Rate limit reached') as Error & {
      error: unknown;
      provider?: string;
    };
    error.error = { error: { code: '1302', message: 'Rate limit reached' } };
    error.provider = 'glm';

    const providerError = formatProviderHttpError(error);

    expect(providerError.exhaustionReason).not.toBe('glm-coding-plan');
  });
});
