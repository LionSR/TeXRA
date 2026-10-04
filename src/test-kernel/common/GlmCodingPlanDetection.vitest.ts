import { ModelProvider } from 'llm-zoo';
import { describe, expect, it } from 'vitest';
import { ModelError } from '@texra-ai/llm';

import { classifyModelFailure } from '@agent/runtime/run/modelFailure';
import { judgeFailure } from '../../../packages/llm/src/api/verdict.js';

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

/** Build a UTC+8 reset timestamp a fixed window in the future. */
function futureCstTimestampBody(minutesFromNow: number): {
  error: { code: string; message: string };
} {
  const resetMs = Date.now() + minutesFromNow * 60 * 1000;
  // Convert to UTC+8 wall-clock, then format as YYYY-MM-DD HH:MM:SS.
  const cst = new Date(resetMs + 8 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const timestamp = `${cst.getUTCFullYear()}-${pad(cst.getUTCMonth() + 1)}-${pad(cst.getUTCDate())} ${pad(cst.getUTCHours())}:${pad(cst.getUTCMinutes())}:${pad(cst.getUTCSeconds())}`;
  return {
    error: {
      code: '1308',
      message: `已达到 5 小时的使用上限。您的限额将在 ${timestamp} 重置。`,
    },
  };
}

/** A GLM Coding Plan 429 as the binding judges it. */
function glmFailure(body: unknown, message = 'GLM rejected the request') {
  return judgeFailure(
    new ModelError({
      kind: 'provider-rejection',
      message,
      status: 429,
      cause: Object.assign(new Error(message), { status: 429, error: body }),
    }),
    'glm-coding-plan-subscription',
  );
}

describe('the GLM Coding Plan quota codes', () => {
  it('read a weekly or five-hour limit as the plan used up', () => {
    expect(glmFailure(WEEKLY_LIMIT_BODY).quota?.plan).toBe(
      'glm-coding-plan-subscription',
    );
    expect(glmFailure(FIVE_HOUR_LIMIT_BODY).quota?.plan).toBe(
      'glm-coding-plan-subscription',
    );
  });

  it('derive the reset window from a UTC+8 China-time timestamp in the message', () => {
    const { quota } = glmFailure(futureCstTimestampBody(30));
    // The reset timestamp is ~30 minutes in the future.
    expect(quota?.resetsInMs).toBeGreaterThan(0);
    expect(quota?.resetsInMs).toBeLessThanOrEqual(30 * 60 * 1000);
  });

  it('ignore non-quota codes', () => {
    for (const code of ['1302', '1305', '1113'])
      expect(
        glmFailure({ error: { code, message: 'not a quota' } }).quota,
      ).toBe(undefined);
  });

  it('read 1302 and 1305 as a retryable plan rate limit with its own hint', () => {
    for (const code of ['1302', '1305']) {
      const judged = glmFailure({
        error: { code, message: '您的账户已达到速率限制，请您控制请求频率' },
      });
      expect(judged).toMatchObject({
        kind: 'rate-limited',
        retryable: true,
        scope: 'route',
      });
      expect(judged.message).toContain('rate limit');
      expect(judged.message).toContain('retry');
    }
  });

  it('offer the switch to the regular GLM endpoint on a used-up plan', () => {
    const { formatted } = classifyModelFailure(glmFailure(WEEKLY_LIMIT_BODY), {
      config: { provider: ModelProvider.GLM },
    });

    expect(formatted.classification?.kind).toBe('glm-coding-plan');
    expect(formatted.userRetryable).toBe(true);
    expect(formatted.message).toContain('GLM Coding Plan usage limit reached');
    expect(formatted.message).toContain('Switch to the regular GLM endpoint');
  });
});
