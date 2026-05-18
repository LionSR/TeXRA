import { describe, expect, it } from 'vitest';
import stripAnsi from 'strip-ansi';

import { renderHeaderBanner } from '../../../packages/cli/src/chat/tui/panes/HeaderBanner';

describe('CLI header banner', () => {
  it('labels the agent and model fields explicitly', () => {
    const text = stripAnsi(
      renderHeaderBanner({
        version: '0.37.8',
        agent: 'bash',
        model: 'gemini31p',
        cwd: '/tmp/project',
      }),
    );

    expect(text).toContain('agent: bash · model: gemini31p');
  });
});
