import { describe, expect, it } from 'vitest';

import { PROVIDER_KEY_REDACTION_RULES, redactSecrets } from '@logger/redaction';
import { API_KEY_PROVIDER_IDS } from '@shared/constants/providers';

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
      for (const sample of PROVIDER_KEY_REDACTION_RULES[provider].examples) {
        const redacted = redactSecrets(`${provider}: ${sample}`);

        expect(redacted).not.toContain(sample);
        expect(redacted).toContain('[redacted]');
      }
    }
  });

  it('keeps API-key provider coverage explicit', () => {
    expect(Object.keys(PROVIDER_KEY_REDACTION_RULES).toSorted()).toEqual(
      [...API_KEY_PROVIDER_IDS].toSorted(),
    );
  });
});
