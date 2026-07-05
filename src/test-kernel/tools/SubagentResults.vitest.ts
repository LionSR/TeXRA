// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import type {
  ToolUseFlowResult,
  WorkflowFlowResult,
} from '@agent/runtime/AgentFlowResult';
import { RUN_OUTCOME } from '@shared/schemas';
import {
  formatBashDelivery,
  formatBashError,
  formatSubagentDelivery,
} from '@tools/subagentResults';

function toolUseResult(
  outcome: ToolUseFlowResult['outcome'] = RUN_OUTCOME.COMPLETED,
  overrides: Partial<ToolUseFlowResult> = {},
): ToolUseFlowResult {
  return {
    category: 'toolUse',
    executionId: 'abc123',
    streamId: 'child-stream',
    outcome,
    ...overrides,
  };
}

describe('formatSubagentDelivery', () => {
  it('escapes tool-use response bodies at the XML boundary', () => {
    const result = toolUseResult(RUN_OUTCOME.COMPLETED, {
      lastResponse:
        'Keep </response> literal & preserve <subagent-result> text.',
    });

    const delivery = formatSubagentDelivery('reviewer', result);

    expect(delivery).toContain(
      'Keep &lt;/response> literal &amp; preserve &lt;subagent-result> text.',
    );
    expect(delivery).not.toContain('Keep </response> literal');
  });

  it('includes attached memory misses in subagent delivery XML', () => {
    const result = toolUseResult(RUN_OUTCOME.COMPLETED, {
      lastResponse: 'Checked the proof.',
      memoryMisses: [
        {
          path: '/memories/missing.md',
          reason: 'Path is missing & unreadable',
        },
      ],
    });

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
      outcome: RUN_OUTCOME.COMPLETED,
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
      outcome: RUN_OUTCOME.COMPLETED,
      outputs: [],
      compileFailures: [],
    } satisfies WorkflowFlowResult;

    expect(formatSubagentDelivery('polish', result)).not.toContain(
      'diffs-unavailable',
    );
  });

  it('emits canonical failed and cancelled statuses for orchestrators', () => {
    expect(
      formatSubagentDelivery('reviewer', toolUseResult(RUN_OUTCOME.FAILED)),
    ).toContain('status="failed"');
    expect(
      formatSubagentDelivery('reviewer', toolUseResult(RUN_OUTCOME.CANCELLED)),
    ).toContain('status="cancelled"');
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

  it('escapes background bash ids at the XML attribute boundary', () => {
    const delivery = formatBashDelivery(
      'bash&1"<',
      'printf lines',
      1000,
      { success: true, stdout: '', stderr: '', exitCode: 0 },
      'ok',
      '',
    );
    const error = formatBashError('bash&1"<', 'printf lines', new Error('no'));

    expect(delivery).toContain('<background-result id="bash&amp;1&quot;&lt;"');
    expect(error).toContain('<background-error id="bash&amp;1&quot;&lt;"');
  });

  it('surfaces the head and an elision count only when a stream was truncated', () => {
    const delivery = formatBashDelivery(
      'bash-3',
      'make build',
      1000,
      { success: false, stdout: '', stderr: '', exitCode: 1 },
      'tail output',
      'tail stderr',
      'first fatal error',
      'first fatal stderr',
      500,
      250,
    );

    expect(delivery).toContain('<output-head>first fatal error</output-head>');
    expect(delivery).toContain(
      '<output-elided>500 characters elided</output-elided>',
    );
    expect(delivery).toContain('<stderr-head>first fatal stderr</stderr-head>');
    expect(delivery).toContain(
      '<stderr-elided>250 characters elided</stderr-elided>',
    );
  });

  it('omits the elision note when the head is not truncated', () => {
    const delivery = formatBashDelivery(
      'bash-4',
      'echo hi',
      1000,
      { success: true, stdout: '', stderr: '', exitCode: 0 },
      'ok',
      '',
    );

    expect(delivery).not.toContain('output-head');
    expect(delivery).not.toContain('elided');
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
