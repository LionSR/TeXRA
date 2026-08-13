import { describe, expect, it } from 'vitest';

import { PROVIDER_KEY_REDACTION_RULES, redactSecrets } from '@logger/redaction';
import { API_KEY_PROVIDER_IDS } from '@shared/constants/providers';

describe('desktop log redaction', () => {
  it('redacts obvious secrets and sensitive path prefixes', () => {
    const redacted = redactSecrets(
      [
        'OPENAI_API_KEY=sk-1234567890abcdef',
        'Authorization: Bearer ghp_1234567890abcdef',
        '/Users/alice/private-paper/main.tex',
        '/Users/alice/.config/texra',
      ].join('\n'),
      {
        homeDir: '/Users/alice',
        workspacePath: '/Users/alice/private-paper',
      },
    );

    expect(redacted).not.toContain('sk-1234567890abcdef');
    expect(redacted).not.toContain('ghp_1234567890abcdef');
    expect(redacted).not.toContain('/Users/alice/private-paper');
    expect(redacted).not.toContain('/Users/alice/.config');
    expect(redacted).toContain('OPENAI_API_KEY=[redacted]');
    expect(redacted).toContain('Bearer [redacted]');
    expect(redacted).toContain('[path]/main.tex');
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
