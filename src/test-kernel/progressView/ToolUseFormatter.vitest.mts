// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - shared schemas
import { LOG_LEVELS, type LogMessageData } from '@shared/schemas';

// Local imports - test utilities
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

useLitComponentTestDom(
  () =>
    import('@progressView/frontend/formatters/logFormatters/toolFormatters'),
);

describe('tool-use formatter', () => {
  it('keeps streamed bash output out of the collapsed error summary', async () => {
    const { formatToolUseTemplate } =
      await import('@progressView/frontend/formatters/logFormatters/toolFormatters');
    const { render } = await import('lit');
    const stdout = Array.from(
      { length: 20 },
      (_, i) => `[${i}/100] Built Mathlib.Example.Module${i}`,
    ).join(' ');
    const message: LogMessageData = {
      id: 'bash-timeout',
      text: '',
      level: LOG_LEVELS.ERROR,
      timestamp: 1,
      messageType: 'toolUse',
      data: {
        toolName: 'bash',
        input: { command: 'lake build' },
        error: `Foreground command timed out after 600s. <stdout>${stdout}`,
        isError: true,
      },
    };

    const container = document.createElement('div');
    render(formatToolUseTemplate(message), container);

    const title = container.querySelector('.tool-use-title');
    const body = container.querySelector('.banner-content');

    expect(title?.textContent).toContain('bash');
    expect(title?.textContent).toContain(
      'Foreground command timed out after 600s.',
    );
    expect(title?.textContent).not.toContain('Built Mathlib');
    expect(body?.textContent).toContain('Built Mathlib.Example.Module19');
  });
});
