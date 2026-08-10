// Third-party imports
import { beforeAll, describe, expect, it } from 'vitest';

// Local imports - shared schemas
import { LOG_LEVELS, type LogMessageData } from '@shared/schemas';

// Local imports - test utilities
import {
  dispatchKey,
  useLitComponentTestDom,
} from '../settings/litComponentTestUtils';

useLitComponentTestDom();

// Imported in a `beforeAll` registered after useLitComponentTestDom's, so the
// jsdom globals these modules touch at import time are already installed.
let formatToolUseTemplate: typeof import('@progressView/frontend/formatters/logFormatters/toolFormatters').formatToolUseTemplate;
let formatLogEntry: typeof import('@progressView/frontend/formatters').formatLogEntry;
let getToolTimeoutMs: typeof import('@progressView/frontend/formatters/logFormatters/toolFormatters/helpers').getToolTimeoutMs;
let formatBannerContentTemplate: typeof import('@progressView/frontend/formatters/logFormatters/bannerFormatters').formatBannerContentTemplate;
let formatErrorTemplate: typeof import('@progressView/frontend/formatters/logFormatters/messageFormatters').formatErrorTemplate;
let render: typeof import('lit').render;

beforeAll(async () => {
  ({ formatToolUseTemplate } =
    await import('@progressView/frontend/formatters/logFormatters/toolFormatters'));
  ({ formatLogEntry } = await import('@progressView/frontend/formatters'));
  ({ getToolTimeoutMs } =
    await import('@progressView/frontend/formatters/logFormatters/toolFormatters/helpers'));
  ({ formatBannerContentTemplate } =
    await import('@progressView/frontend/formatters/logFormatters/bannerFormatters'));
  ({ formatErrorTemplate } =
    await import('@progressView/frontend/formatters/logFormatters/messageFormatters'));
  ({ render } = await import('lit'));
});

/** What a log formatter hands to lit: a template, or its decline sentinel. */
type FormatterTemplate =
  ReturnType<typeof formatToolUseTemplate> | ReturnType<typeof formatLogEntry>;

/** Renders a formatter's template into a detached container to query. */
function renderTemplate(template: FormatterTemplate): HTMLElement {
  const container = document.createElement('div');
  render(template, container);
  return container;
}

/**
 * Renders into a container attached to the document, for the cases that need
 * a real ancestor chain (event bubbling) and connected custom elements.
 */
function renderTemplateInDocument(template: FormatterTemplate): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  render(template, container);
  return container;
}

/** The shared shell of an INFO-level tool-use log entry. */
function toolUseMessage(id: string, data: unknown): LogMessageData {
  return {
    id,
    text: '',
    level: LOG_LEVELS.INFO,
    timestamp: 1,
    messageType: 'toolUse',
    data,
  };
}

/** Renders an `executions` tool call with subagent labels and returns the title. */
function executionsTitle(
  input: Record<string, unknown>,
  labels: [string, string][],
): string | null | undefined {
  const container = renderTemplate(
    formatToolUseTemplate(
      toolUseMessage('executions-title', { toolName: 'executions', input }),
      { executionLabels: new Map(labels) },
    ),
  );
  return container.querySelector('.tool-use-title')?.textContent;
}

describe('tool-use formatter', () => {
  it('renders workflow-script delegation details without proposal or journal data', () => {
    const script = `export const meta = {
  name: 'Literature synthesis',
  phases: [{ title: 'Collect' }, { title: 'Compare' }],
};

const papers = await parallel(
  args.paperIds.map((paperId) => () =>
    agent(\`Read and assess \${paperId}\`, { label: paperId }),
  ),
);
return { papers, question: args.question };`;
    const message = toolUseMessage('workflow-script', {
      toolName: 'delegate_multi_agents',
      input: {
        agent: 'research',
        script,
        args: {
          paperIds: ['2401.00001', '2401.00002'],
          question: 'Which assumptions differ?',
        },
        files: {
          inputFiles: ['paper.tex'],
          contextFiles: ['references.bib'],
          mediaFiles: ['figure.pdf'],
        },
      },
      output: {
        status: 'executed',
        summary:
          "Completed workflow script 'Literature synthesis' (2 agent calls)",
        output: JSON.stringify({ compared: 2 }),
      },
    });

    const container = renderTemplate(formatToolUseTemplate(message));

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

    expect(details?.open).toBe(false);
    expect(container.querySelector('.tool-use-title')?.textContent).toContain(
      'Literature synthesis',
    );
    expect(container.querySelector('wa-icon[name="list-ul"]')).not.toBeNull();
    expect(labels).toEqual(['Agent:', 'Script:', 'Args:', 'Files:']);
    expect(container.textContent).toContain('research');
    expect(scriptBlock?.querySelector('code')?.textContent).toBe(script);
    expect(scriptBlock?.textContent).toContain('JavaScript');
    expect(argsBlock?.querySelector('code')?.textContent).toContain(
      '"question": "Which assumptions differ?"',
    );
    expect(container.textContent).toContain('paper.tex');
    expect(container.textContent).toContain('references.bib');
    expect(container.textContent).toContain('figure.pdf');
    expect(container.textContent).toContain('(Input)');
    expect(container.textContent).toContain('(Context)');
    expect(container.textContent).toContain('(Media)');
    expect(container.textContent).not.toContain('"compared":2');
    expect(container.textContent).not.toContain('journal');
    expect(container.querySelector('.proposal-banner-setup')).toBeNull();
  });

  it('keeps an in-progress workflow script compact by default', () => {
    const container = renderTemplate(
      formatToolUseTemplate(
        toolUseMessage('workflow-script-running', {
          toolName: 'delegate_multi_agents',
          status: 'in_progress',
          input: {
            agent: 'research',
            script:
              "export const meta = { name: 'Review team', description: 'Review' }; return null;",
          },
        }),
      ),
    );
    const details = container.querySelector('wa-details.tool-use-details') as
      (HTMLElement & { open: boolean }) | null;

    expect(details?.open).toBe(false);
    expect(container.querySelector('.tool-use-title')?.textContent).toContain(
      'Review team',
    );
    expect(container.querySelector('tool-timer')).not.toBeNull();
  });

  it('shows explicit null workflow-script arguments as JSON', () => {
    const message = toolUseMessage('workflow-script-null-args', {
      toolName: 'delegate_multi_agents',
      input: {
        agent: 'research',
        script: 'export const meta = { name: "One call" };\nreturn null;',
        args: null,
      },
    });

    const container = renderTemplate(formatToolUseTemplate(message));

    expect(
      container.querySelector('.code-block[data-language="json"] code')
        ?.textContent,
    ).toBe('null');
  });

  it('keeps streamed bash output out of the collapsed error summary', () => {
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

    const container = renderTemplate(formatToolUseTemplate(message));

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

  it('renders write_file cards even when compact logs omit content', () => {
    const message = toolUseMessage('write-file-compact', {
      toolName: 'write_file',
      input: { path: 'src/main.ts' },
      output: 'Wrote src/main.ts',
    });

    const container = renderTemplate(formatLogEntry(message));

    expect(container.textContent).toContain('write_file');
    expect(container.textContent).toContain('src/main.ts');
    expect(container.textContent).not.toContain('Failed to render');
  });

  // Entries as `buildClaudeToolUseLog` (src/tools/claudeAgentShared.ts) and
  // `buildCodexMcpToolLog` (src/tools/codexShared.ts) persist them into a
  // stream log: a namespaced `claude:<tool>` name, and `mcp:<server>/<tool>`.
  it('strips the provider namespace from a delegated sub-agent tool title', () => {
    const message = toolUseMessage('claude-edit', {
      toolName: 'claude:Edit',
      summary: 'paper.tex',
      input: {
        file_path: 'paper.tex',
        old_string: 'We use a CNN.',
        new_string: 'We use a transformer.',
      },
      status: 'completed',
    });

    const container = renderTemplate(formatToolUseTemplate(message));

    const title = container.querySelector('.tool-use-title')?.textContent;
    expect(title).toBe('Edit — paper.tex');
  });

  it('gives a delegated bash call the same command preview as the native tool', () => {
    const message = toolUseMessage('claude-bash', {
      toolName: 'claude:Bash',
      input: { command: 'npm test' },
      output: 'passed',
      status: 'completed',
    });

    const container = renderTemplate(formatToolUseTemplate(message));

    expect(container.querySelector('.tool-use-title')?.textContent).toBe(
      'Bash — npm test',
    );
    expect(
      container.querySelector('terminal-output.tool-output-terminal'),
    ).not.toBeNull();
  });

  it('keeps the MCP provenance marker in the tool title', () => {
    const message = toolUseMessage('mcp-search', {
      toolName: 'mcp:github/search',
      input: { query: 'texra' },
      output: { status: 'completed' },
    });

    const container = renderTemplate(formatToolUseTemplate(message));

    expect(container.querySelector('.tool-use-title')?.textContent).toContain(
      'MCP github/search',
    );
  });

  it('caps executions wait timeout displays at the tool maximum', () => {
    const input = {
      path: '/executions/abc123',
      action: 'wait',
      timeout: 3600,
    };
    const message = toolUseMessage('executions-timeout', {
      toolName: 'executions',
      input,
    });

    expect(getToolTimeoutMs('executions', input)).toBe(1_800_000);
    expect(getToolTimeoutMs('executions', { ...input, timeout: 30 })).toBe(
      60_000,
    );

    const container = renderTemplate(formatToolUseTemplate(message));

    expect(container.textContent).toContain('wait (timeout: 1800s)');
    expect(container.textContent).not.toContain('3600s');
  });

  it('renders guarded executions conversation pagination arguments', () => {
    const valid = renderTemplate(
      formatToolUseTemplate(
        toolUseMessage('executions-conversation-page', {
          toolName: 'executions',
          input: {
            path: '/executions/abc123/conversation',
            offset: 0,
            limit: 25,
          },
        }),
      ),
    );
    const labels = [...valid.querySelectorAll('.tool-use-sublabel')].map(
      (label) => label.textContent,
    );

    expect(labels).toEqual(['Path:', 'Offset:', 'Limit:']);
    expect(valid.textContent).toContain('0');
    expect(valid.textContent).toContain('25');

    const invalid = renderTemplate(
      formatToolUseTemplate(
        toolUseMessage('executions-invalid-conversation-page', {
          toolName: 'executions',
          input: {
            path: '/executions/abc123/conversation',
            offset: '0',
            limit: null,
          },
        }),
      ),
    );
    expect(invalid.textContent).not.toContain('Offset:');
    expect(invalid.textContent).not.toContain('Limit:');
  });

  it('labels executions targets when the display model knows the subagents', () => {
    expect(
      executionsTitle(
        {
          action: 'wait',
          path: '/executions',
          ids: ['sub-1', 'sub-2'],
        },
        [
          ['sub-1', 'reviewer'],
          ['sub-2', 'leanSolver'],
        ],
      ),
    ).toBe('executions — wait: reviewer, leanSolver');
  });

  it('keeps the resource path when labeling an executions target', () => {
    expect(
      executionsTitle({ path: '/executions/sub-1/workspace-files/review.md' }, [
        ['sub-1', 'reviewer'],
      ]),
    ).toBe('executions — view: reviewer/workspace-files/review.md');
  });

  it('keeps the existing executions title for a background process', () => {
    expect(
      executionsTitle({ action: 'view', path: '/executions/process-1' }, [
        ['sub-1', 'reviewer'],
      ]),
    ).toBe('executions — view /executions/process-1');
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

const ACTIVATION_KEYS = ['Enter', ' '] as const;

const SUMMARY_CONTROL_CASES = [
  {
    control: 'proposal-restore-link',
    detailsSelector: 'wa-details.tool-use-details',
    controlSelector: 'button.proposal-restore-link',
    buildTemplate: () =>
      formatToolUseTemplate({
        id: 'proposal-2',
        text: '',
        level: LOG_LEVELS.INFO,
        timestamp: 1,
        messageType: 'toolUse',
        data: {
          toolName: 'delegate_agent',
          input: { agent: 'assistant', instruction: 'do the thing' },
          output: 'proposed',
        },
      }),
  },
  {
    control: 'copy button',
    detailsSelector: 'wa-details.banner-details',
    controlSelector: 'wa-button.banner-content-copy',
    buildTemplate: () =>
      formatBannerContentTemplate({
        id: 'thinking-1',
        text: 'some thinking content',
        level: LOG_LEVELS.INFO,
        timestamp: 1,
        messageType: 'thinking',
        data: {},
      }),
  },
  {
    control: 'error banner copy button',
    detailsSelector: 'wa-details.banner-details--error',
    controlSelector: 'wa-button.banner-content-copy',
    buildTemplate: () =>
      formatErrorTemplate({
        id: 'error-1',
        text: 'something failed',
        level: LOG_LEVELS.ERROR,
        timestamp: 1,
        messageType: 'error',
        data: { operation: 'test-op' },
      }),
  },
];

describe('wa-details summary controls: activation does not toggle the panel', () => {
  it('clicking the proposal-restore-link ("Setup") button does not toggle the panel, and the click still bubbles to an outer delegated handler', async () => {
    const message = toolUseMessage('proposal-1', {
      toolName: 'delegate_agent',
      input: { agent: 'assistant', instruction: 'do the thing' },
      output: 'proposed',
    });

    const container = renderTemplateInDocument(formatToolUseTemplate(message));

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

  it.each(
    SUMMARY_CONTROL_CASES.flatMap((summaryCase) =>
      ACTIVATION_KEYS.map((key) => ({ ...summaryCase, key })),
    ),
  )(
    'keydown $key on the $control does not toggle the panel',
    async ({ detailsSelector, controlSelector, buildTemplate, key }) => {
      const container = renderTemplateInDocument(buildTemplate());

      const waDetails = container.querySelector(
        detailsSelector,
      ) as WaDetailsElement | null;
      expect(waDetails).not.toBeNull();
      await waDetails!.updateComplete;

      const control = container.querySelector(controlSelector) as
        (HTMLElement & { updateComplete?: Promise<boolean> }) | null;
      expect(control).not.toBeNull();
      if (control!.updateComplete) await control!.updateComplete;

      expect(waDetails!.open).toBe(false);
      dispatchKey(control!, key);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(waDetails!.open).toBe(false);
    },
  );
});
