// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { formatDelivery } from '@agent/runtime/deliveryEnvelope';
import { formatSubagentDelivery } from '@agent/runtime/subagentResults';
import {
  RUN_OUTCOME,
  type RunEnd,
  type RunEndOutput,
  type RunId,
} from '@shared/schemas';
import {
  formatBashDelivery,
  formatBashError,
} from '@tools/delegation/bashDelivery';

function toolUseResult(
  outcome: RunEnd['outcome'] = RUN_OUTCOME.COMPLETED,
  output: Partial<RunEndOutput> = {},
): RunEnd {
  return {
    outcome,
    output: { response: '', files: [], ...output },
  };
}

function seconds(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

// formatDelivery is the one builder behind every child-run delivery: the
// native subagent path (formatSubagentDelivery/formatSubagentError), the
// background-bash path, workflow scripts, and the agent-CLI tools (codex.ts,
// claudeAgent.ts). An error report is the same envelope carrying `message`.
// The cases below replay the exact parameter mappings used at the real call
// sites; the expected strings are byte-identical to what the pre-merge
// agent-CLI formatters (formatAgentCliDelivery/formatAgentCliError) produced.

describe('formatDelivery', () => {
  it('truncates the echoed prompt to 200 chars and escapes attrs/text', () => {
    const longPrompt = 'x'.repeat(250);
    const xml = formatDelivery({
      tag: 'codex-result',
      runId: 'a&b"<c',
      prompt: `${longPrompt}<&"`,
      attributes: [{ name: 'thread-id', value: '<id&"' }],
      wallTime: seconds(100),
      response: 'a < b & c "q"',
    });
    // id/prompt/thread-id are attribute-escaped (&, ", < — not >); the prompt is
    // sliced to 200 chars BEFORE escaping, so the trailing <&" never appears.
    expect(xml).toContain(
      `<codex-result id="a&amp;b&quot;&lt;c" prompt="${'x'.repeat(200)}" thread-id="&lt;id&amp;&quot;">`,
    );
    // response is text-escaped (&, < — quotes left intact)
    expect(xml).toContain('<response>a &lt; b &amp; c "q"</response>');
  });
});

describe('formatSubagentDelivery', () => {
  it('escapes tool-use response bodies at the XML boundary', () => {
    const result = toolUseResult(RUN_OUTCOME.COMPLETED, {
      response: 'Keep </response> literal & preserve <subagent-result> text.',
    });

    const delivery = formatSubagentDelivery('reviewer', result, {
      runId: 'abc123' as RunId,
    });

    expect(delivery).toContain(
      'Keep &lt;/response> literal &amp; preserve &lt;subagent-result> text.',
    );
    expect(delivery).not.toContain('Keep </response> literal');
  });
});

describe('formatBashDelivery', () => {
  it('keeps all content lines when a background output tail ends at the preview limit', () => {
    const outputTail = Array.from(
      { length: 20 },
      (_, index) => `line-${String(index + 1).padStart(2, '0')}`,
    ).join('\n');

    const delivery = formatBashDelivery(
      'bash-1',
      { command: 'printf lines' },
      1000,
      { success: true, stdout: '', stderr: '', timedOut: false, exitCode: 0 },
      { tail: `${outputTail}\n` },
      { tail: '' },
    );

    expect(delivery).toContain('line-01');
    expect(delivery).toContain('line-20');
  });

  it('escapes background bash ids at the XML attribute boundary', () => {
    const delivery = formatBashDelivery(
      'bash&1"<',
      { command: 'printf lines' },
      1000,
      { success: true, stdout: '', stderr: '', timedOut: false, exitCode: 0 },
      { tail: 'ok' },
      { tail: '' },
    );
    const error = formatBashError(
      'bash&1"<',
      { command: 'printf lines' },
      new Error('no'),
    );

    expect(delivery).toContain('<background-result id="bash&amp;1&quot;&lt;"');
    expect(error).toContain('<background-error id="bash&amp;1&quot;&lt;"');
  });

  it('normalizes CRLF when truncating background output previews', () => {
    const outputTail = Array.from(
      { length: 21 },
      (_, index) => `line-${String(index + 1).padStart(2, '0')}`,
    ).join('\r\n');

    const delivery = formatBashDelivery(
      'bash-2',
      { command: 'printf lines' },
      1000,
      { success: true, stdout: '', stderr: '', timedOut: false, exitCode: 0 },
      { tail: `${outputTail}\r\n` },
      { tail: '' },
    );

    expect(delivery).not.toContain('line-01');
    expect(delivery).toContain('line-02');
    expect(delivery).toContain('line-21');
    expect(delivery).not.toContain('\r');
  });
});
