// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - tools
import { formatCIStarted } from '@tools/github/formatPREvent';
import type { GhCheckRun } from '@tools/github/prTypes';

function checkRun(id: number, name: string): GhCheckRun {
  return {
    id,
    name,
    status: 'in_progress',
    conclusion: null,
    html_url: `https://example.test/checks/${id}`,
    completed_at: null,
  };
}

describe('GitHub PR event formatting', () => {
  it('formats CI-started events using check-name wording', () => {
    const message = formatCIStarted(
      'owner/repo',
      7,
      'abcdef1234567890',
      [checkRun(1, 'lint'), checkRun(2, 'test')],
      5,
    );

    expect(message).toContain(
      'CI triggered on owner/repo/pulls/7 (head abcdef1): GitHub reports 5 checks registered; this poll observed 2 checks across 2 distinct check names.',
    );
    expect(message).toContain('- lint');
    expect(message).toContain('- test');
    expect(message).not.toContain('workflow');
  });

  it('bounds the CI-started check-name list', () => {
    const message = formatCIStarted(
      'owner/repo',
      7,
      'abcdef1234567890',
      Array.from({ length: 25 }, (_, i) =>
        checkRun(i + 1, `check-${String(i + 1).padStart(2, '0')}`),
      ),
      25,
    );

    const bullets = message.match(/^- /gm) ?? [];
    expect(bullets).toHaveLength(20);
    expect(message).toContain('…and 5 more check names.');
  });
});
