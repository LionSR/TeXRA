import { describe, expect, it } from 'vitest';

import {
  API_ACCESS_MODE_OPTIONS,
  ApiAccessModeSchema,
  describeApiAccessModeStatus,
  MODEL_ACCESS_ROUTE_LABELS,
  ModelAccessStatusSchema,
} from '@shared/schemas/modelAccess';

describe('shared model-access contract', () => {
  it('defines the API fallback values and labels for every host', () => {
    expect(ApiAccessModeSchema.options).toEqual(['included', 'personal']);
    expect(
      API_ACCESS_MODE_OPTIONS.map(({ value, label }) => ({ value, label })),
    ).toEqual([
      { value: 'included', label: MODEL_ACCESS_ROUTE_LABELS.included },
      { value: 'personal', label: MODEL_ACCESS_ROUTE_LABELS.personal },
    ]);
  });

  it('validates subscription, relay, and API-key status together', () => {
    expect(
      ModelAccessStatusSchema.parse({
        apiMode: 'personal',
        chatGpt: {
          signedIn: true,
          email: 'researcher@example.com',
          accountId: null,
          preferSubscription: true,
          subscriptionToolUseOnly: false,
        },
        kimiCode: { keySet: true, preferred: true },
        personalApiKeySet: true,
        texraSignedIn: false,
      }),
    ).toMatchObject({
      apiMode: 'personal',
      personalApiKeySet: true,
      texraSignedIn: false,
    });
  });

  it('derives identical fallback status text for CLI and GUI', () => {
    const status = { personalApiKeySet: false, texraSignedIn: false };

    expect(describeApiAccessModeStatus('included', status)).toBe(
      'TeXRA account sign-in required',
    );
    expect(describeApiAccessModeStatus('personal', status)).toBe(
      'No provider API keys configured',
    );
  });
});
