// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import type {
  ToolUseFlowResult,
  WorkflowFlowResult,
} from '@agent/runtime/AgentFlowResult';
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

  it('includes attached memory misses in subagent delivery XML', () => {
    const result = {
      category: 'toolUse',
      executionId: 'abc123',
      streamId: 'child-stream',
      status: 'stopped',
      lastResponse: 'Checked the proof.',
      memoryMisses: [
        {
          path: '/memories/missing.md',
          reason: 'Path is missing & unreadable',
        },
      ],
    } satisfies ToolUseFlowResult;

    const delivery = formatSubagentDelivery('reviewer', result);

    expect(delivery).toContain('<memory-misses>');
    expect(delivery).toContain(
      '<memory-miss path="/memories/missing.md" reason="Path is missing &amp; unreadable" />',
    );
  });

  it('flags failed diff computation so orchestrators read outputs directly', () => {
    const result = {
      category: 'workflow',
      executionId: 'abc123',
      streamId: 'child-stream',
      status: 'stopped',
      outputs: [
        {
          round: 0,
          relativePath: 'paper.tex',
          absolutePath: '/ws/paper.tex',
          location: 'workspace',
          originalPath: '/ws/.texra/paper.orig.tex',
          added: 3,
          removed: 1,
        },
      ],
      compileFailures: [],
    } satisfies WorkflowFlowResult;

    const delivery = formatSubagentDelivery('polish', result, {
      diffsUnavailable: 'ENOSPC: no space left & disk full',
    });

    expect(delivery).toContain(
      '<diffs-unavailable reason="ENOSPC: no space left &amp; disk full">',
    );
    expect(delivery).toContain('read the output files directly');
    expect(delivery).toContain('<file path="paper.tex"');
  });

  it('omits the diffs-unavailable element on clean deliveries', () => {
    const result = {
      category: 'workflow',
      executionId: 'abc123',
      streamId: 'child-stream',
      status: 'stopped',
      outputs: [],
      compileFailures: [],
    } satisfies WorkflowFlowResult;

    expect(formatSubagentDelivery('polish', result)).not.toContain(
      'diffs-unavailable',
    );
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
