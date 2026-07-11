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

    // Element-name pin (#8156): tool-use banners render through <wa-details>,
    // matching the wa-details convention used elsewhere on this surface —
    // never the native <details> element.
    expect(
      container.querySelector('wa-details.tool-use-details'),
    ).not.toBeNull();
    expect(container.querySelector('details')).toBeNull();
  });

  it('renders write_file cards even when compact logs omit content', async () => {
    const { formatLogEntry } =
      await import('@progressView/frontend/formatters');
    const { render } = await import('lit');
    const message: LogMessageData = {
      id: 'write-file-compact',
      text: '',
      level: LOG_LEVELS.INFO,
      timestamp: 1,
      messageType: 'toolUse',
      data: {
        toolName: 'write_file',
        input: { path: 'src/main.ts' },
        output: 'Wrote src/main.ts',
      },
    };

    const container = document.createElement('div');
    render(formatLogEntry(message), container);

    expect(container.textContent).toContain('write_file');
    expect(container.textContent).toContain('src/main.ts');
    expect(container.textContent).not.toContain('Failed to render');
  });

  it('caps executions wait timeout displays at the tool maximum', async () => {
    const { formatToolUseTemplate } =
      await import('@progressView/frontend/formatters/logFormatters/toolFormatters');
    const { getToolTimeoutMs } =
      await import('@progressView/frontend/formatters/logFormatters/toolFormatters/helpers');
    const { render } = await import('lit');
    const input = {
      path: '/executions/abc123',
      action: 'wait',
      timeout: 3600,
    };
    const message: LogMessageData = {
      id: 'executions-timeout',
      text: '',
      level: LOG_LEVELS.INFO,
      timestamp: 1,
      messageType: 'toolUse',
      data: {
        toolName: 'executions',
        input,
      },
    };

    expect(getToolTimeoutMs('executions', input)).toBe(1_800_000);
    expect(getToolTimeoutMs('executions', { ...input, timeout: 30 })).toBe(
      60_000,
    );

    const container = document.createElement('div');
    render(formatToolUseTemplate(message), container);

    expect(container.textContent).toContain('wait (timeout: 1800s)');
    expect(container.textContent).not.toContain('3600s');
  });
});
