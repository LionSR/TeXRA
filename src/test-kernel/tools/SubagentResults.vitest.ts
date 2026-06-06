// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import type { ToolUseFlowResult } from '@agent/runtime/AgentFlowResult';
import {
  formatBashDelivery,
  formatSubagentDelivery,
} from '@tools/subagentResults';

describe('formatSubagentDelivery', () => {
  it('escapes tool-use response bodies at the XML boundary', () => {
    const result = {
      category: 'toolUse',
      executionId: 'abc123',
      streamId: 'child-stream',
      status: 'stopped',
      lastResponse:
        'Keep </response> literal & preserve <subagent-result> text.',
    } satisfies ToolUseFlowResult;

    const delivery = formatSubagentDelivery('reviewer', result);

    expect(delivery).toContain(
      'Keep &lt;/response> literal &amp; preserve &lt;subagent-result> text.',
    );
    expect(delivery).not.toContain('Keep </response> literal');
  });

  it('keeps all content lines when a background output tail ends at the preview limit', () => {
    const outputTail = Array.from(
      { length: 20 },
      (_, index) => `line-${String(index + 1).padStart(2, '0')}`,
    ).join('\n');

    const delivery = formatBashDelivery(
      'bash-1',
      'printf lines',
      1000,
      { success: true, stdout: '', stderr: '', exitCode: 0 },
      `${outputTail}\n`,
      '',
    );

    expect(delivery).toContain('line-01');
    expect(delivery).toContain('line-20');
  });

  it('normalizes CRLF when truncating background output previews', () => {
    const outputTail = Array.from(
      { length: 21 },
      (_, index) => `line-${String(index + 1).padStart(2, '0')}`,
    ).join('\r\n');

    const delivery = formatBashDelivery(
      'bash-2',
      'printf lines',
      1000,
      { success: true, stdout: '', stderr: '', exitCode: 0 },
      `${outputTail}\r\n`,
      '',
    );

    expect(delivery).not.toContain('line-01');
    expect(delivery).toContain('line-02');
    expect(delivery).toContain('line-21');
    expect(delivery).not.toContain('\r');
  });
});
