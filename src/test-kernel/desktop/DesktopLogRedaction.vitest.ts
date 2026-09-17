import { describe, expect, it } from 'vitest';

import { redactSecrets } from '@logger/redaction';
import { API_KEY_PROVIDER_IDS } from '@shared/constants/providers';

/**
 * Representative keys for each configurable provider's key shape. These are
 * the test's own fixture — production names the shapes it redacts, not
 * examples of them. The `satisfies` keeps the fixture exhaustive: a provider
 * added to `API_KEY_PROVIDER_IDS` must gain a sample here, so no provider
 * reaches the suite below untested.
 */
const PROVIDER_KEY_EXAMPLES = {
  openai: ['sk-proj-redaction-example-1234567890abcdef'],
  anthropic: ['sk-ant-api03-redaction-example-1234567890abcdef'],
  openRouter: ['sk-or-v1-redaction-example-1234567890abcdef'],
  google: [
    'AIzaSyRedactionExample1234567890abcdef',
    'AQ.AbRedactionExample1234567890abcdef',
  ],
  xai: ['xai-redaction-example-1234567890abcdef'],
  deepseek: ['sk-provider-redaction-example-1234567890abcdef'],
  moonshot: ['sk-kimi-redaction-example-1234567890abcdef'],
  dashscope: [
    'sk-redaction-example-1234567890abcdef',
    'sk-ws-redaction-example-1234567890abcdef',
  ],
  minimax: ['sk-cp-redaction-example-1234567890abcdef'],
  glm: ['sk-provider-redaction-example-1234567890abcdef'],
  meta: ['sk-provider-redaction-example-1234567890abcdef'],
  kimiCode: ['sk-provider-redaction-example-1234567890abcdef'],
} as const satisfies Record<
  (typeof API_KEY_PROVIDER_IDS)[number],
  readonly string[]
>;

describe('desktop log redaction', () => {
  it('redacts secret patterns and leaves ordinary paths intact', () => {
    const redacted = redactSecrets(
      [
        'OPENAI_API_KEY=sk-1234567890abcdef',
        'Authorization: Bearer ghp_1234567890abcdef',
        '/Users/alice/private-paper/main.tex',
        '/Users/alice/.config/texra',
      ].join('\n'),
    );

    expect(redacted).not.toContain('sk-1234567890abcdef');
    expect(redacted).not.toContain('ghp_1234567890abcdef');
    expect(redacted).toContain('OPENAI_API_KEY=[redacted]');
    expect(redacted).toContain('Bearer [redacted]');
    // No production call site ever passed LogRedactionOptions, so the old
    // homeDir/workspacePath path-scrubbing branch was dead. Desktop hosts scrub
    // paths separately via redactPathPrefixes before redactSecrets. Pin the
    // actual redactSecrets contract: secret patterns redact, paths do not.
    expect(redacted).toContain('/Users/alice/private-paper/main.tex');
    expect(redacted).toContain('/Users/alice/.config/texra');
  });

  it('redacts complete quoted secret assignments', () => {
    const redacted = redactSecrets(
      `PASSWORD="correct horse" API_TOKEN='battery staple'`,
    );

    expect(redacted).toBe('PASSWORD=[redacted] API_TOKEN=[redacted]');
  });

  it('redacts representative API key shapes for every configurable provider', () => {
    for (const provider of API_KEY_PROVIDER_IDS) {
      for (const sample of PROVIDER_KEY_EXAMPLES[provider]) {
        const redacted = redactSecrets(`${provider}: ${sample}`);

        expect(redacted).not.toContain(sample);
        expect(redacted).toContain('[redacted]');
      }
    }
  });

  it('keeps API-key provider coverage explicit', () => {
    // Production's own table is exhaustive by construction (it `satisfies
    // Record<ApiKeyProviderId, …>`); what needs pinning here is that the
    // fixture above kept up, so every provider is actually exercised.
    expect(Object.keys(PROVIDER_KEY_EXAMPLES).toSorted()).toEqual(
      [...API_KEY_PROVIDER_IDS].toSorted(),
    );
  });
});
