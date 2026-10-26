// Third-party imports
import { beforeAll, describe, expect, it } from 'vitest';

// Local imports - shared schemas
import { LOG_LEVELS } from '@shared/schemas';
import type { RunLabels } from '@shared/tools/executionsDisplay';
import { decodeToolUseLog } from '@shared/toolUse';
import type { ToolRow } from '@shared/transcript/transcriptRow';
import { toolRow } from '@shared/transcript/projectTranscriptRow';

// Local imports - test utilities
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

useLitComponentTestDom();

// Imported in a `beforeAll` registered after useLitComponentTestDom's, so the
// jsdom globals these modules touch at import time are already installed.
let formatToolUseTemplate: typeof import('@progressView/frontend/formatters/logFormatters/toolFormatters').formatToolUseTemplate;
let getToolTimeoutMs: typeof import('@progressView/frontend/formatters/logFormatters/toolFormatters/helpers').getToolTimeoutMs;
let render: typeof import('lit').render;

beforeAll(async () => {
  ({ formatToolUseTemplate } =
    await import('@progressView/frontend/formatters/logFormatters/toolFormatters'));
  ({ getToolTimeoutMs } =
    await import('@progressView/frontend/formatters/logFormatters/toolFormatters/helpers'));
  ({ render } = await import('lit'));
});

/** What the tool-use formatter hands to lit. */
type FormatterTemplate = ReturnType<typeof formatToolUseTemplate>;

/** Renders a formatter's template into a detached container to query. */
function renderTemplate(template: FormatterTemplate): HTMLElement {
  const container = document.createElement('div');
  render(template, container);
  return container;
}

/** The tool row an INFO-level tool-use payload builds. */
function toolUseRow(
  id: string,
  data: Record<string, unknown>,
  runLabels?: RunLabels,
): ToolRow {
  return toolRow(
    { id, seqNo: 1, level: LOG_LEVELS.INFO, timestamp: 1 },
    decodeToolUseLog(data),
    undefined,
    runLabels,
  );
}

describe('tool-use formatter', () => {
  it('caps executions wait timeout displays at the tool maximum', () => {
    const input = {
      path: '/executions/abc123',
      action: 'wait',
      timeout: 3600,
    };
    const row = toolUseRow('executions-timeout', {
      toolName: 'executions',
      input,
    });

    expect(getToolTimeoutMs('executions', input)).toBe(1_800_000);
    expect(getToolTimeoutMs('executions', { ...input, timeout: 30 })).toBe(
      60_000,
    );

    const container = renderTemplate(formatToolUseTemplate(row));

    expect(container.textContent).toContain('wait (timeout: 1800s)');
    expect(container.textContent).not.toContain('3600s');
  });
});
