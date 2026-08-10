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

  it('fails closed when otherwise useful prose contains a path', () => {
    expect(
      parseDescription(
        'Review the proof using /Users/Jane Doe/Top Secret Draft/final-private-notes.tex before publication.',
      ),
    ).toBe(DESCRIPTION_FALLBACK);
    expect(
      parseDescription(
        'Compare against C:\\Users\\Jane Doe\\Top Secret Draft\\final-private-notes.tex before publication.',
      ),
    ).toBe(DESCRIPTION_FALLBACK);
  });

  it('preserves ordinary URL schemes while stripping controls', () => {
    expect(
      parseDescription(
        'Read \u001b[31mhttps://example.com/docs/file.html\u001b[0m and custom+https://example.org/reference.',
      ),
    ).toBe(
      'Read https://example.com/docs/file.html and custom+https://example.org/reference.',
    );
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
