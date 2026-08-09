import { describe, expect, it, vi } from 'vitest';

import {
  CHATGPT_USAGE_URL,
  parseChatGptUsage,
  type SubscriptionUsageHttp,
} from '@controllers/modelAccess/subscriptionUsage/codexUsageAdapter';
import {
  GLM_CODING_PLAN_INTERNATIONAL_USAGE_URL,
  GLM_CODING_PLAN_USAGE_URL,
  parseGlmCodingPlanUsage,
} from '@controllers/modelAccess/subscriptionUsage/glmCodingPlanUsageAdapter';
import {
  KIMI_CODE_USAGE_URL,
  parseKimiCodeUsage,
} from '@controllers/modelAccess/subscriptionUsage/kimiCodeUsageAdapter';
import {
  SubscriptionUsageService,
  type SubscriptionUsageCredentials,
} from '@controllers/modelAccess/subscriptionUsage/SubscriptionUsageService';
import { SubscriptionUsageSnapshotSchema } from '@shared/schemas';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function credentials(
  overrides: Partial<SubscriptionUsageCredentials> = {},
): SubscriptionUsageCredentials {
  return {
    loadChatGpt: async () => ({
      accessToken: 'chatgpt-secret',
      accountId: 'account-123',
    }),
    loadApiKey: async (provider) => `${provider}-secret`,
    ...overrides,
  };
}

function serviceWith(
  http: SubscriptionUsageHttp,
  credentialSource = credentials(),
  options: { readonly now?: () => number; readonly cacheTtlMs?: number } = {},
): SubscriptionUsageService {
  return new SubscriptionUsageService({
    http,
    credentials: credentialSource,
    now: options.now ?? (() => 1_800_000_000_000),
    cacheTtlMs: options.cacheTtlMs,
  });
}

describe('subscription usage parsers', () => {
  it('parses ChatGPT primary and secondary rate-limit windows', () => {
    expect(
      parseChatGptUsage({
        plan_type: 'pro',
        rate_limit: {
          primary_window: {
            used_percent: 25,
            limit_window_seconds: 18_000,
            reset_at: 1_800_000_100,
          },
          secondary_window: {
            used_percent: 40,
            limit_window_seconds: 604_800,
            expiry_date: '2027-01-15T08:00:00Z',
          },
        },
      }),
    ).toStrictEqual({
      planName: 'pro',
      windows: [
        {
          name: 'five_hour',
          percentUsed: 25,
          percentRemaining: 75,
          resetAt: 1_800_000_100_000,
          limitWindowSeconds: 18_000,
        },
        {
          name: 'seven_day',
          percentUsed: 40,
          percentRemaining: 60,
          resetAt: Date.parse('2027-01-15T08:00:00Z'),
          limitWindowSeconds: 604_800,
        },
      ],
    });
  });

  it('parses normalized ChatGPT windows and relative reset variants', () => {
    expect(
      parseChatGptUsage(
        {
          rate_limits: {
            plan_type: 'team',
            primary: {
              used_percent: '12.5',
              window_minutes: 300,
              reset_after_seconds: 60,
            },
            secondary: {
              remaining_percent: 75,
              resets_in_seconds: 120,
            },
          },
        },
        1_800_000_000_000,
      ),
    ).toStrictEqual({
      planName: 'team',
      windows: [
        {
          name: 'five_hour',
          percentUsed: 12.5,
          percentRemaining: 87.5,
          resetAt: 1_800_000_060_000,
          limitWindowSeconds: 18_000,
        },
        {
          name: 'secondary',
          percentUsed: 25,
          percentRemaining: 75,
          resetAt: 1_800_000_120_000,
        },
      ],
    });
  });

  it('falls back to normalized ChatGPT windows and names stable durations', () => {
    const mixed = parseChatGptUsage({
      rate_limit: {
        primary_window: { used_percent: 'invalid' },
      },
      rate_limits: {
        primary: { used_percent: 10, limit_window_seconds: 2_592_000 },
        secondary: { used_percent: 20, limit_window_seconds: 172_800 },
      },
    });

    expect(mixed.windows.map((window) => window.name)).toStrictEqual([
      'thirty_day',
      '2_day',
    ]);
  });

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY])(
    'omits invalid ChatGPT window metadata: %s',
    (limitWindowSeconds) => {
      const parsed = parseChatGptUsage({
        rate_limit: {
          primary_window: {
            used_percent: 10,
            limit_window_seconds: limitWindowSeconds,
          },
        },
      });

      expect(parsed.windows).toStrictEqual([
        { name: 'primary', percentUsed: 10, percentRemaining: 90 },
      ]);
      expect(
        SubscriptionUsageSnapshotSchema.safeParse({
          state: 'available',
          provider: 'chatgpt',
          providerName: 'ChatGPT',
          planName: parsed.planName,
          fetchedAt: 1,
          windows: parsed.windows,
        }).success,
      ).toBe(true);
    },
  );

  it('parses Kimi limit/remaining windows and legacy USD quota records', () => {
    expect(
      parseKimiCodeUsage({
        limits: [
          {
            detail: {
              limit: 100,
              remaining: 30,
              resetTime: 1_800_001_000_000,
            },
          },
        ],
        usage: {
          limit: '500',
          used: '100',
          resetTime: '2027-01-20T08:30:00Z',
        },
      }).windows,
    ).toStrictEqual([
      {
        name: 'five_hour',
        percentUsed: 70,
        percentRemaining: 30,
        resetAt: 1_800_001_000_000,
      },
      {
        name: 'weekly_limit',
        percentUsed: 20,
        percentRemaining: 80,
        resetAt: Date.parse('2027-01-20T08:30:00Z'),
      },
    ]);

    expect(
      parseKimiCodeUsage({
        data: {
          limits: {
            quota_5_hour: {
              used_value_usd: 2,
              max_value_usd: 8,
              resets_at: '2027-01-01T00:00:00Z',
            },
            quota_7_day: { usedValueUsd: 9, maxValueUsd: 10 },
          },
        },
      }).windows.map((window) => [window.name, window.percentUsed]),
    ).toStrictEqual([
      ['quota_5_hour', 25],
      ['quota_7_day', 90],
    ]);
  });

  it('parses GLM token limits by unit and nested remaining variants', () => {
    expect(
      parseGlmCodingPlanUsage({
        success: true,
        data: {
          level: 'Lite',
          limits: [
            {
              type: 'TOKENS_LIMIT',
              percentage: 30,
              nextResetTime: 1_800_003_000_000,
              unit: 3,
              number: 5,
            },
            {
              type: 'tokens_limit',
              percentage: 55,
              nextResetTime: 1_800_004_000_000,
              unit: 6,
              number: 7,
            },
          ],
        },
      }),
    ).toStrictEqual({
      planName: 'Lite',
      windows: [
        {
          name: 'five_hour',
          percentUsed: 30,
          percentRemaining: 70,
          resetAt: 1_800_003_000_000,
        },
        {
          name: 'weekly',
          percentUsed: 55,
          percentRemaining: 45,
          resetAt: 1_800_004_000_000,
        },
      ],
    });

    expect(
      parseGlmCodingPlanUsage({
        data: {
          model_remains: {
            'glm-5': {
              current_interval_remaining_percent: 80,
              current_weekly_remaining_percent: 65,
              weekly_end_time: 1_800_005_000,
            },
          },
        },
      }).windows,
    ).toStrictEqual([
      {
        name: 'glm-5:five_hour',
        percentUsed: 20,
        percentRemaining: 80,
      },
      {
        name: 'glm-5:weekly',
        percentUsed: 35,
        percentRemaining: 65,
        resetAt: 1_800_005_000_000,
      },
    ]);
  });

  it('parses current GLM credit limits for five-hour and weekly usage', () => {
    const parsed = parseGlmCodingPlanUsage({
      success: true,
      data: {
        level: 'Pro',
        limits: [
          {
            type: 'CREDIT_LIMIT',
            percentage: 18,
            unit: 3,
            number: 5,
            nextResetTime: 1_800_006_000_000,
          },
          {
            type: 'credit_limit',
            percentage: 42,
            unit: 6,
            number: 7,
            nextResetTime: 1_800_007_000_000,
          },
        ],
      },
    });

    expect(parsed.windows).toStrictEqual([
      {
        name: 'five_hour',
        percentUsed: 18,
        percentRemaining: 82,
        resetAt: 1_800_006_000_000,
      },
      {
        name: 'weekly',
        percentUsed: 42,
        percentRemaining: 58,
        resetAt: 1_800_007_000_000,
      },
    ]);
  });

  it('ignores unrelated GLM limits and classifies unknown units by reset', () => {
    const parsed = parseGlmCodingPlanUsage({
      data: {
        limits: [
          { percentage: 1, unit: 3, nextResetTime: 1_700_000_000_000 },
          {
            type: 'REQUESTS_LIMIT',
            percentage: 2,
            unit: 3,
            nextResetTime: 1_700_000_000_000,
          },
          {
            type: 'tokens_limit',
            percentage: 30,
            unit: 99,
            nextResetTime: 1_800_000_000_000,
          },
          {
            type: 'TOKENS_LIMIT',
            percentage: 40,
            unit: 100,
            nextResetTime: 1_900_000_000_000,
          },
        ],
      },
    });

    expect(
      parsed.windows.map((window) => [window.name, window.percentUsed]),
    ).toStrictEqual([
      ['five_hour', 30],
      ['weekly', 40],
    ]);
  });
});

describe('SubscriptionUsageService', () => {
  it.each([
    {
      provider: 'chatgpt' as const,
      url: CHATGPT_USAGE_URL,
      response: {
        rate_limit: { primary_window: { used_percent: 10 } },
      },
      authorization: 'Bearer chatgpt-secret',
      extraHeaders: {
        'ChatGPT-Account-Id': 'account-123',
        'User-Agent': 'codex-cli',
      },
    },
    {
      provider: 'kimiCode' as const,
      url: KIMI_CODE_USAGE_URL,
      response: { usage: { limit: 10, remaining: 5 } },
      authorization: 'Bearer kimiCode-secret',
      extraHeaders: {},
    },
    {
      provider: 'glmCodingPlan' as const,
      url: GLM_CODING_PLAN_USAGE_URL,
      response: {
        success: true,
        data: {
          limits: [{ type: 'TOKENS_LIMIT', percentage: 10, unit: 3 }],
        },
      },
      authorization: 'glm-secret',
      extraHeaders: { 'Accept-Language': 'en-US,en' },
    },
  ])(
    'sends the required $provider authentication headers',
    async ({ provider, url, response, authorization, extraHeaders }) => {
      const http = vi.fn<SubscriptionUsageHttp>(async () =>
        jsonResponse(response),
      );
      const snapshot = await serviceWith(http).getUsage(provider);

      expect(snapshot.state).toBe('available');
      expect(SubscriptionUsageSnapshotSchema.parse(snapshot)).toStrictEqual(
        snapshot,
      );
      expect(http).toHaveBeenCalledTimes(1);
      const [calledUrl, init] = http.mock.calls[0];
      expect(calledUrl).toBe(url);
      expect(init.method).toBe('GET');
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.headers).toMatchObject({
        Authorization: authorization,
        ...extraHeaders,
      });
    },
  );

  it.each([
    [true, GLM_CODING_PLAN_USAGE_URL],
    [false, GLM_CODING_PLAN_INTERNATIONAL_USAGE_URL],
  ])(
    'uses the configured GLM region endpoint: China=%s',
    async (useChina, expectedUrl) => {
      const http = vi.fn<SubscriptionUsageHttp>(async () =>
        jsonResponse({
          success: true,
          data: {
            limits: [{ type: 'TOKENS_LIMIT', percentage: 10, unit: 3 }],
          },
        }),
      );

      await serviceWith(
        http,
        credentials({ useGlmChina: () => useChina }),
      ).getUsage('glmCodingPlan');

      expect(http.mock.calls[0][0]).toBe(expectedUrl);
    },
  );

  it('does not reuse GLM usage from the previous region after invalidation', async () => {
    let useChina = true;
    const http = vi.fn<SubscriptionUsageHttp>(async (url) =>
      jsonResponse({
        success: true,
        data: {
          limits: [
            {
              type: 'TOKENS_LIMIT',
              percentage: url === GLM_CODING_PLAN_USAGE_URL ? 10 : 80,
              unit: 3,
            },
          ],
        },
      }),
    );
    const service = serviceWith(
      http,
      credentials({ useGlmChina: () => useChina }),
      { cacheTtlMs: 60_000 },
    );

    const china = await service.getUsage('glmCodingPlan');
    useChina = false;
    service.invalidate('glmCodingPlan');
    const international = await service.getUsage('glmCodingPlan');

    expect(http.mock.calls.map(([url]) => url)).toStrictEqual([
      GLM_CODING_PLAN_USAGE_URL,
      GLM_CODING_PLAN_INTERNATIONAL_USAGE_URL,
    ]);
    expect(china.state === 'available' && china.windows[0]?.percentUsed).toBe(
      10,
    );
    expect(
      international.state === 'available' &&
        international.windows[0]?.percentUsed,
    ).toBe(80);
  });

  it('does not fall back across GLM hosts when the selected region fails', async () => {
    const http = vi.fn<SubscriptionUsageHttp>(async () =>
      jsonResponse({ message: 'unavailable' }, 500),
    );
    const snapshot = await serviceWith(
      http,
      credentials({ useGlmChina: () => false }),
    ).getUsage('glmCodingPlan');

    expect(http).toHaveBeenCalledExactlyOnceWith(
      GLM_CODING_PLAN_INTERNATIONAL_USAGE_URL,
      expect.any(Object),
    );
    expect(snapshot).toMatchObject({
      state: 'unavailable',
      reason: 'request_failed',
    });
  });

  it.each([
    ['chatgpt' as const, credentials({ loadChatGpt: async () => null })],
    [
      'kimiCode' as const,
      credentials({
        loadApiKey: async (provider) =>
          provider === 'kimiCode' ? undefined : 'glm-secret',
      }),
    ],
    [
      'glmCodingPlan' as const,
      credentials({
        loadApiKey: async (provider) =>
          provider === 'glm' ? undefined : 'kimi-secret',
      }),
    ],
  ])(
    'returns unavailable when %s credentials are missing',
    async (provider, source) => {
      const http = vi.fn<SubscriptionUsageHttp>();

      await expect(
        serviceWith(http, source).getUsage(provider),
      ).resolves.toMatchObject({
        state: 'unavailable',
        provider,
        reason: 'missing_credentials',
        windows: [],
      });
      expect(http).not.toHaveBeenCalled();
    },
  );

  it('represents Grok as unsupported without making a request', async () => {
    const http = vi.fn<SubscriptionUsageHttp>();
    await expect(serviceWith(http).getUsage('grok')).resolves.toMatchObject({
      state: 'unavailable',
      reason: 'unsupported',
    });
    expect(http).not.toHaveBeenCalled();
  });

  it.each([
    ['chatgpt' as const, 401],
    ['kimiCode' as const, 403],
    ['glmCodingPlan' as const, 401],
  ])(
    'maps %s HTTP %s to invalid credentials without exposing details',
    async (provider, status) => {
      const http = vi.fn<SubscriptionUsageHttp>(async () =>
        jsonResponse({ secret: 'must not escape' }, status),
      );

      const snapshot = await serviceWith(http).getUsage(provider);
      expect(snapshot).toMatchObject({
        state: 'unavailable',
        reason: 'invalid_credentials',
      });
      expect(JSON.stringify(snapshot)).not.toContain('secret');
    },
  );

  it('normalizes malformed bodies and HTTP failures without exposing details', async () => {
    const malformed = vi.fn<SubscriptionUsageHttp>(async () =>
      jsonResponse({ rate_limit: { primary_window: { used_percent: 'bad' } } }),
    );
    await expect(
      serviceWith(malformed).getUsage('chatgpt'),
    ).resolves.toMatchObject({
      state: 'unavailable',
      reason: 'malformed_response',
    });

    const invalidJson = vi.fn<SubscriptionUsageHttp>(
      async () => new Response('{', { status: 200 }),
    );
    await expect(
      serviceWith(invalidJson).getUsage('kimiCode'),
    ).resolves.toMatchObject({
      state: 'unavailable',
      reason: 'malformed_response',
    });

    const failed = vi.fn<SubscriptionUsageHttp>(async () =>
      jsonResponse({ secret: 'must not escape' }, 500),
    );
    const snapshot = await serviceWith(failed).getUsage('glmCodingPlan');
    expect(snapshot).toMatchObject({
      state: 'unavailable',
      reason: 'request_failed',
    });
    expect(JSON.stringify(snapshot)).not.toContain('secret');
  });

  it('times out provider requests and returns an unavailable snapshot', async () => {
    const http = vi.fn<SubscriptionUsageHttp>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            {
              once: true,
            },
          );
        }),
    );
    const service = new SubscriptionUsageService({
      http,
      credentials: credentials(),
      requestTimeoutMs: 1,
    });

    await expect(service.getUsage('chatgpt')).resolves.toMatchObject({
      state: 'unavailable',
      reason: 'request_failed',
    });
  });

  it('uses the TTL cache and forced refresh bypasses it', async () => {
    let now = 1000;
    const http = vi.fn<SubscriptionUsageHttp>(async () =>
      jsonResponse({ usage: { limit: 100, remaining: 50 } }),
    );
    const service = serviceWith(http, credentials(), {
      now: () => now,
      cacheTtlMs: 100,
    });

    const first = await service.getUsage('kimiCode');
    expect(await service.getUsage('kimiCode')).toBe(first);
    expect(http).toHaveBeenCalledTimes(1);

    await service.getUsage('kimiCode', { forceRefresh: true });
    expect(http).toHaveBeenCalledTimes(2);

    now += 101;
    await service.getUsage('kimiCode');
    expect(http).toHaveBeenCalledTimes(3);
  });

  it('invalidates cached provider snapshots after credentials change', async () => {
    let remaining = 50;
    const http = vi.fn<SubscriptionUsageHttp>(async () =>
      jsonResponse({ usage: { limit: 100, remaining } }),
    );
    const service = serviceWith(http);

    await expect(service.getUsage('kimiCode')).resolves.toMatchObject({
      windows: [expect.objectContaining({ percentUsed: 50 })],
    });
    remaining = 25;
    service.invalidate('kimiCode');
    await expect(service.getUsage('kimiCode')).resolves.toMatchObject({
      windows: [expect.objectContaining({ percentUsed: 75 })],
    });
    expect(http).toHaveBeenCalledTimes(2);
  });

  it('replaces an invalidated in-flight snapshot instead of returning old-account usage', async () => {
    const responses: Array<(response: Response) => void> = [];
    const http = vi.fn<SubscriptionUsageHttp>(
      () =>
        new Promise<Response>((resolve) => {
          responses.push(resolve);
        }),
    );
    const service = serviceWith(http);

    const oldAccountRequest = service.getUsage('kimiCode');
    await vi.waitFor(() => expect(responses).toHaveLength(1));
    service.invalidate('kimiCode');
    const newAccountRequest = service.getUsage('kimiCode');
    await vi.waitFor(() => expect(responses).toHaveLength(2));

    responses[0]?.(jsonResponse({ usage: { limit: 100, remaining: 90 } }));
    responses[1]?.(jsonResponse({ usage: { limit: 100, remaining: 20 } }));

    const [oldCallerSnapshot, newCallerSnapshot] = await Promise.all([
      oldAccountRequest,
      newAccountRequest,
    ]);
    expect(oldCallerSnapshot).toMatchObject({
      windows: [expect.objectContaining({ percentUsed: 80 })],
    });
    expect(oldCallerSnapshot).toStrictEqual(newCallerSnapshot);
  });

  it('deduplicates concurrent requests for the same provider', async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    const response = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const http = vi.fn<SubscriptionUsageHttp>(() => response);
    const service = serviceWith(http);

    const first = service.getUsage('chatgpt');
    const second = service.getUsage('chatgpt');
    await vi.waitFor(() => expect(http).toHaveBeenCalledTimes(1));
    resolveResponse?.(
      jsonResponse({
        rate_limit: { primary_window: { used_percent: 10 } },
      }),
    );

    const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);
    expect(secondSnapshot).toBe(firstSnapshot);
    expect(http).toHaveBeenCalledTimes(1);
  });
});
