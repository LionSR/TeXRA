import { describe, expect, it } from 'vitest';

const ratchet = await import(
  // @ts-expect-error This internal JavaScript script intentionally has no declaration file.
  '../../../scripts/check-dead-code-ratchet-core.mjs'
);
const { diffFindings, parseKnipIssues } = ratchet;
type KnipFinding = {
  file: string;
  category: 'files' | 'exports' | 'types' | 'duplicates';
  name: string;
};

describe('check-dead-code-ratchet parseKnipIssues', () => {
  it('rejects partial JSON findings when Knip reports a configuration error', () => {
    const stderr =
      '\u001b[31mERROR\u001b[39m: Error loading packages/extension/vite.config.mts (VITE_WEBVIEW must name a webview (progressView, settingsView), got: webview)';

    expect(() => parseKnipIssues('{"issues":[]}', stderr)).toThrow(
      'knip reported an analysis error',
    );
  });
});

describe('check-dead-code-ratchet diffFindings', () => {
  const baseline: KnipFinding[] = [
    { file: 'a.ts', category: 'exports', name: 'foo' },
    { file: 'b.ts', category: 'types', name: 'Bar' },
  ];

  it('flags a finding present in current but absent from the baseline as new, by identity not count', () => {
    // Same total count as baseline (2), but a different export replaced
    // `foo` -- a pure count comparison would miss this entirely.
    const current: KnipFinding[] = [
      { file: 'a.ts', category: 'exports', name: 'newlyUnused' },
      { file: 'b.ts', category: 'types', name: 'Bar' },
    ];

    expect(diffFindings(current, baseline)).toEqual({
      newFindings: [{ file: 'a.ts', category: 'exports', name: 'newlyUnused' }],
      resolvedFindings: [{ file: 'a.ts', category: 'exports', name: 'foo' }],
    });
  });
});
