// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - shared schemas
import { LOG_LEVELS, type LogMessageData } from '@shared/schemas';

// Local imports - test utilities
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

useLitComponentTestDom(() =>
  Promise.all([
    import('@progressView/frontend/formatters/logFormatters/toolFormatters'),
    import('@progressView/frontend/formatters/logFormatters/bannerFormatters'),
    import('@progressView/frontend/formatters/logFormatters/messageFormatters'),
  ]),
);

describe('tool-use formatter', () => {
  it('renders workflow-script delegation details without proposal or journal data', async () => {
    const { formatToolUseTemplate } =
      await import('@progressView/frontend/formatters/logFormatters/toolFormatters');
    const { render } = await import('lit');
    const script = `export const meta = {
  name: 'Literature synthesis',
  phases: [{ title: 'Collect' }, { title: 'Compare' }],
};

const papers = await parallel(args.paperIds, async (paperId) =>
  agent(\`Read and assess \${paperId}\`, { label: paperId }),
);
return { papers, question: args.question };`;
    const message: LogMessageData = {
      id: 'workflow-script',
      text: '',
      level: LOG_LEVELS.INFO,
      timestamp: 1,
      messageType: 'toolUse',
      data: {
        toolName: 'delegate_workflow_script',
        input: {
          agent: 'research',
          script,
          args: {
            paperIds: ['2401.00001', '2401.00002'],
            question: 'Which assumptions differ?',
          },
        },
        output: {
          result: { compared: 2 },
          agentCalls: 2,
          journal: [{ index: 0, key: 'private-key', result: 'private-result' }],
        },
      },
    };

    const container = document.createElement('div');
    render(formatToolUseTemplate(message, { defaultOpen: true }), container);

    const details = container.querySelector('wa-details.tool-use-details') as
      (HTMLElement & { open: boolean }) | null;
    const scriptBlock = container.querySelector(
      '.code-block[data-language="javascript"]',
    );
    const argsBlock = container.querySelector(
      '.code-block[data-language="json"]',
    );
    const labels = [...container.querySelectorAll('.tool-use-sublabel')].map(
      (label) => label.textContent,
    );

    expect(details?.open).toBe(true);
    expect(container.querySelector('wa-icon[name="list-tree"]')).not.toBeNull();
    expect(labels).toEqual(['Agent:', 'Script:', 'Args:', 'Result:']);
    expect(container.textContent).toContain('research');
    expect(scriptBlock?.querySelector('code')?.textContent).toBe(script);
    expect(scriptBlock?.textContent).toContain('JavaScript');
    expect(argsBlock?.querySelector('code')?.textContent).toContain(
      '"question": "Which assumptions differ?"',
    );
    expect(container.textContent).toContain('compared: 2');
    expect(container.textContent).not.toContain('journal');
    expect(container.textContent).not.toContain('private-key');
    expect(container.querySelector('.proposal-banner-setup')).toBeNull();
  });

  it('shows explicit null workflow-script arguments as JSON', async () => {
    const { formatToolUseTemplate } =
      await import('@progressView/frontend/formatters/logFormatters/toolFormatters');
    const { render } = await import('lit');
    const message: LogMessageData = {
      id: 'workflow-script-null-args',
      text: '',
      level: LOG_LEVELS.INFO,
      timestamp: 1,
      messageType: 'toolUse',
      data: {
        toolName: 'delegate_workflow_script',
        input: {
          agent: 'research',
          script: 'export const meta = { name: "One call" };\nreturn null;',
          args: null,
        },
      },
    };

    const container = document.createElement('div');
    render(formatToolUseTemplate(message), container);

    expect(
      container.querySelector('.code-block[data-language="json"] code')
        ?.textContent,
    ).toBe('null');
  });

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

/**
 * Regression coverage for PR #8165 review findings: controls slotted into a
 * `<wa-details>` summary (the "Setup" proposal-restore-link and the copy
 * button) must not toggle the panel when activated, via mouse or keyboard.
 *
 * `<wa-details>`'s own summary click handler already excludes real
 * `<button>`/`<wa-button>` elements from its toggle, but its keydown handler
 * has no such check — every Enter/Space keydown that bubbles to the summary
 * toggles regardless of origin. `stopSummaryToggleKeydown` (htmlBuilders.ts)
 * stops those keydowns from reaching wa-details' summary at all.
 */
type WaDetailsElement = HTMLElement & {
  open: boolean;
  updateComplete: Promise<boolean>;
};

function dispatchActivationKeydown(target: EventTarget, key: 'Enter' | ' ') {
  target.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      composed: true,
      cancelable: true,
    }),
  );
}

describe('wa-details summary controls: activation does not toggle the panel', () => {
  it('clicking the proposal-restore-link ("Setup") button does not toggle the panel, and the click still bubbles to an outer delegated handler', async () => {
    const { formatToolUseTemplate } =
      await import('@progressView/frontend/formatters/logFormatters/toolFormatters');
    const { render } = await import('lit');
    const message: LogMessageData = {
      id: 'proposal-1',
      text: '',
      level: LOG_LEVELS.INFO,
      timestamp: 1,
      messageType: 'toolUse',
      data: {
        toolName: 'propose_agent',
        input: { agent: 'assistant', instruction: 'do the thing' },
        output: 'proposed',
      },
    };

    const container = document.createElement('div');
    document.body.appendChild(container);
    render(formatToolUseTemplate(message), container);

    const waDetails = container.querySelector(
      'wa-details.tool-use-details',
    ) as WaDetailsElement | null;
    expect(waDetails).not.toBeNull();
    await waDetails!.updateComplete;

    const setupButton = container.querySelector(
      'button.proposal-restore-link',
    ) as HTMLButtonElement | null;
    expect(setupButton).not.toBeNull();

    let ancestorSawClick = false;
    container.addEventListener('click', () => {
      ancestorSawClick = true;
    });

    expect(waDetails!.open).toBe(false);
    setupButton!.click();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(waDetails!.open).toBe(false);
    expect(ancestorSawClick).toBe(true);
  });

  it.each(['Enter', ' '] as const)(
    'keydown %j on the proposal-restore-link does not toggle the panel',
    async (key) => {
      const { formatToolUseTemplate } =
        await import('@progressView/frontend/formatters/logFormatters/toolFormatters');
      const { render } = await import('lit');
      const message: LogMessageData = {
        id: 'proposal-2',
        text: '',
        level: LOG_LEVELS.INFO,
        timestamp: 1,
        messageType: 'toolUse',
        data: {
          toolName: 'propose_agent',
          input: { agent: 'assistant', instruction: 'do the thing' },
          output: 'proposed',
        },
      };

      const container = document.createElement('div');
      document.body.appendChild(container);
      render(formatToolUseTemplate(message), container);

      const waDetails = container.querySelector(
        'wa-details.tool-use-details',
      ) as WaDetailsElement | null;
      await waDetails!.updateComplete;
      const setupButton = container.querySelector(
        'button.proposal-restore-link',
      ) as HTMLButtonElement | null;
      expect(setupButton).not.toBeNull();

      expect(waDetails!.open).toBe(false);
      dispatchActivationKeydown(setupButton!, key);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(waDetails!.open).toBe(false);
    },
  );

  it.each(['Enter', ' '] as const)(
    'keydown %j on the copy button does not toggle the panel',
    async (key) => {
      const { formatBannerContentTemplate } =
        await import('@progressView/frontend/formatters/logFormatters/bannerFormatters');
      const { render } = await import('lit');
      const message: LogMessageData = {
        id: 'thinking-1',
        text: 'some thinking content',
        level: LOG_LEVELS.INFO,
        timestamp: 1,
        messageType: 'thinking',
        data: {},
      };

      const container = document.createElement('div');
      document.body.appendChild(container);
      render(formatBannerContentTemplate(message), container);

      const waDetails = container.querySelector(
        'wa-details.banner-details',
      ) as WaDetailsElement | null;
      expect(waDetails).not.toBeNull();
      await waDetails!.updateComplete;

      const copyButton = container.querySelector(
        'wa-button.banner-content-copy',
      ) as (HTMLElement & { updateComplete?: Promise<boolean> }) | null;
      expect(copyButton).not.toBeNull();
      if (copyButton!.updateComplete) await copyButton!.updateComplete;

      expect(waDetails!.open).toBe(false);
      dispatchActivationKeydown(copyButton!, key);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(waDetails!.open).toBe(false);
    },
  );

  it.each(['Enter', ' '] as const)(
    'keydown %j on the error banner copy button does not toggle the panel',
    async (key) => {
      const { formatErrorTemplate } =
        await import('@progressView/frontend/formatters/logFormatters/messageFormatters');
      const { render } = await import('lit');
      const message: LogMessageData = {
        id: 'error-1',
        text: 'something failed',
        level: LOG_LEVELS.ERROR,
        timestamp: 1,
        messageType: 'error',
        data: { operation: 'test-op' },
      };

      const container = document.createElement('div');
      document.body.appendChild(container);
      render(formatErrorTemplate(message), container);

      const waDetails = container.querySelector(
        'wa-details.banner-details--error',
      ) as WaDetailsElement | null;
      expect(waDetails).not.toBeNull();
      await waDetails!.updateComplete;

      const copyButton = container.querySelector(
        'wa-button.banner-content-copy',
      ) as (HTMLElement & { updateComplete?: Promise<boolean> }) | null;
      expect(copyButton).not.toBeNull();
      if (copyButton!.updateComplete) await copyButton!.updateComplete;

      expect(waDetails!.open).toBe(false);
      dispatchActivationKeydown(copyButton!, key);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(waDetails!.open).toBe(false);
    },
  );
});
