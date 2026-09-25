import { describe, expect, it } from 'vitest';

import {
  ActiveSkillSummarySchema,
  ActiveSkillsSnapshotSchema,
} from '@shared/schemas';

const DESCRIPTION_FALLBACK = 'Details available on activation.';

function parseDescription(description: string): string {
  return ActiveSkillSummarySchema.parse({
    name: 'proof-audit',
    description,
    source: 'project',
  }).description;
}

describe('active skill safe summaries', () => {
  it('uses the canonical skill-name grammar', () => {
    expect(parseDescription('Review proofs.')).toBe('Review proofs.');

    for (const name of [
      'Proof Audit',
      'proof_audit',
      'proof--audit',
      '-proof-audit',
      'proof-audit-',
      '\u001b[31mproof-audit\u001b[0m',
    ]) {
      expect(
        ActiveSkillSummarySchema.safeParse({
          name,
          description: 'Review proofs.',
          source: 'project',
        }).success,
      ).toBe(false);
    }
  });

  it.each([
    ['POSIX', '/Users/Jane Doe/Top Secret Draft/final-private-notes.tex'],
    [
      'Windows drive',
      'C:\\Users\\Jane Doe\\Top Secret Draft\\final-private-notes.tex',
    ],
    [
      'UNC',
      '\\\\research-server\\Jane Doe\\Top Secret Draft\\final-private-notes.tex',
    ],
    ['home', '~/Jane Doe/Top Secret Draft/final-private-notes.tex'],
    ['named home', '~janedoe/Top Secret Draft/final-private-notes.tex'],
    ['dot relative', './Jane Doe/Top Secret Draft/final-private-notes.tex'],
    [
      'parent relative',
      '..\\Jane Doe\\Top Secret Draft\\final-private-notes.tex',
    ],
    ['POSIX neutral names', 'clients/acme'],
    ['POSIX extensionless two-component', 'private/key'],
    ['POSIX hyphenated names', 'client-name/private-key'],
    ['POSIX whitespace path', 'Client Name/private key'],
    ['Windows neutral names', 'clients\\acme'],
    ['Windows extensionless two-component', 'private\\key'],
    ['Windows hyphenated names', 'client-name\\private-key'],
    ['Windows whitespace path', 'Client Name\\private key'],
    ['POSIX relative', 'secrets/client-name/key.pem'],
    ['POSIX relative with spaces', 'secrets/Client Name/private key.pem'],
    ['POSIX dotted directory', 'config.d/key.pem'],
    ['POSIX hidden filename', 'secrets/.env'],
    ['POSIX extensionless filename', 'secrets/credentials'],
    ['Windows relative', 'secrets\\client-name\\key.pem'],
    ['Windows relative with spaces', 'secrets\\Client Name\\private key.pem'],
    ['Windows dotted directory', 'config.d\\key.pem'],
    ['Windows hidden filename', 'secrets\\.env'],
    ['Windows extensionless filename', 'secrets\\credentials'],
    [
      'file URI',
      'file:///Users/Jane Doe/Top Secret Draft/final-private-notes.tex',
    ],
    [
      'colon adjacent',
      'Path:/Users/Jane Doe/Top Secret Draft/final-private-notes.tex',
    ],
  ])('fails closed for %s paths', (_label, path) => {
    const description = parseDescription(path);

    expect(description).toBe(DESCRIPTION_FALLBACK);
    for (const leakedPart of [
      'Jane',
      'Top',
      'Secret',
      'Draft',
      'final',
      'private',
      'notes',
      '.tex',
    ]) {
      expect(description).not.toContain(leakedPart);
    }
  });

  it.each([
    'Review the proof using /Users/Jane Doe/Top Secret Draft/final-private-notes.tex before publication.',
    'Compare against C:\\Users\\Jane Doe\\Top Secret Draft\\final-private-notes.tex before publication.',
    'Review clients/acme before publication.',
    'Review clients\\acme before publication.',
    'Load Client Name/private key before publication.',
    'Load Client Name\\private key before publication.',
  ])('fails closed when otherwise useful prose contains a path: %s', (text) => {
    expect(parseDescription(text)).toBe(DESCRIPTION_FALLBACK);
  });

  it('preserves ordinary prose and URL schemes while stripping controls', () => {
    expect(
      parseDescription(
        'Read \u001b[31mhttps://example.com/docs/file.html\u001b[0m and custom+https://example.org/reference.',
      ),
    ).toBe(
      'Read https://example.com/docs/file.html and custom+https://example.org/reference.',
    );
    expect(parseDescription('Compare input/output formatting choices.')).toBe(
      'Compare input/output formatting choices.',
    );
    expect(parseDescription('Compare inputs/outputs formatting choices.')).toBe(
      DESCRIPTION_FALLBACK,
    );
    expect(parseDescription('Compare input\\output formatting choices.')).toBe(
      DESCRIPTION_FALLBACK,
    );
    expect(
      parseDescription(
        'Read https://example.com/config.d/key.pem, https://example.org/secrets/.env, and custom+https://example.net/secrets/credentials.',
      ),
    ).toBe(
      'Read https://example.com/config.d/key.pem, https://example.org/secrets/.env, and custom+https://example.net/secrets/credentials.',
    );
    expect(
      parseDescription(
        'Search https://example.com/find?q=proof%20audit&sort=name#result:top, then continue.',
      ),
    ).toBe(
      'Search https://example.com/find?q=proof%20audit&sort=name#result:top, then continue.',
    );
    expect(parseDescription('Visit https://example.com for details.')).toBe(
      'Visit https://example.com for details.',
    );
  });

  it.each([
    'Read https://example.com\\C:\\Users\\Jane\\secret.tex before continuing.',
    'Read https://example.com/docs?source=C:\\Users\\Jane\\secret.tex.',
  ])('rejects a URL followed by or containing a Windows path: %s', (text) => {
    expect(parseDescription(text)).toBe(DESCRIPTION_FALLBACK);
  });

  it('uses the same fallback when sanitization removes all content', () => {
    for (const description of [
      '\u001b[31m\u001b[0m',
      '\u0001\u0002\u007f\u009b',
    ]) {
      expect(parseDescription(description)).toBe(DESCRIPTION_FALLBACK);
    }
  });

  it('caps safe descriptions after sanitization', () => {
    const parsed = ActiveSkillsSnapshotSchema.parse({
      skills: [
        {
          name: 'long-description',
          description: `\u001b[31m${'a'.repeat(240)}\u001b[0m`,
          source: 'custom',
        },
      ],
    });

    expect(parsed.skills[0]?.description).toBe('a'.repeat(180));
  });
});
