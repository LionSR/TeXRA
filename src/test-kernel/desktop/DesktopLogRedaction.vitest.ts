import { describe, expect, it } from 'vitest';

import { API_KEY_PROVIDER_IDS } from '@texra-ai/llm';
import { redactDisplayValue, redactSecrets } from '@logger/redaction';

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
  it('redacts representative API key shapes for every configurable provider', () => {
    for (const provider of API_KEY_PROVIDER_IDS) {
      for (const sample of PROVIDER_KEY_EXAMPLES[provider]) {
        const redacted = redactSecrets(`${provider}: ${sample}`);

        expect(redacted).not.toContain(sample);
        expect(redacted).toContain('[redacted]');
      }
    }
  });
});

// A raw `data` payload reaches `redactDisplayValue` before any sink renders
// it. An `Error`'s fields are non-enumerable, so the walk must flatten
// it or the render at the sink would show `{}` where the error was.
describe('redactDisplayValue over raw log payloads', () => {
  it('flattens an Error, cause chain included, and scrubs it like any payload', () => {
    const key = 'sk-provider-redaction-example-1234567890abcdef';
    const error = new Error(`outer failure holding ${key}`, {
      cause: new Error('inner cause'),
    });
    const redacted = redactDisplayValue({ data: error });

    const rendered = JSON.stringify(redacted);
    expect(rendered).not.toContain(key);
    expect(rendered).toContain('outer failure holding [redacted]');
    expect(rendered).toContain('inner cause');
    expect(rendered).toContain('"name":"Error"');
    expect(rendered).toContain('"stack"');
  });
});
