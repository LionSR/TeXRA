// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import {
  RUN_OUTCOME,
  type RunEnd,
  type RunEndOutput,
  type RunId,
} from '@shared/schemas';
import { formatDelivery } from '@tools/delegation/deliveryEnvelope';
import {
  formatBashDelivery,
  formatBashError,
} from '@tools/delegation/bashDelivery';
import {
  formatSubagentDelivery,
  formatSubagentError,
} from '@tools/delegation/subagentResults';

type ToolUseOutput = Extract<RunEndOutput, { category: 'toolUse' }>;
type WorkflowOutput = Extract<RunEndOutput, { category: 'workflow' }>;

function toolUseResult(
  outcome: RunEnd['outcome'] = RUN_OUTCOME.COMPLETED,
  output: Partial<Omit<ToolUseOutput, 'category'>> = {},
): RunEnd {
  return {
    outcome,
    output: { category: 'toolUse', response: '', files: [], ...output },
  };
}

function workflowResult(
  output: Partial<Omit<WorkflowOutput, 'category'>> = {},
): RunEnd {
  return {
    outcome: RUN_OUTCOME.COMPLETED,
    output: {
      category: 'workflow',
      outputs: [],
      compileFailures: [],
      diffs: [],
      ...output,
    },
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

  it('flags failed diff computation so orchestrators read outputs directly', () => {
    const result = workflowResult({
      outputs: [
        {
          round: 0,
          relativePath: 'paper.tex',
          absolutePath: '/storage/executions/abc123/paper.tex',
          location: 'runStorage',
          originalPath: '/ws/.texra/paper.orig.tex',
          added: 3,
          removed: 1,
        },
      ],
      diffsUnavailable: 'ENOSPC: no space left & disk full',
    });

    const delivery = formatSubagentDelivery('polish', result, {
      runId: 'abc123' as RunId,
    });

    expect(delivery).toContain(
      '<diffs-unavailable reason="ENOSPC: no space left &amp; disk full">',
    );
    expect(delivery).toContain('read the output files directly');
    expect(delivery).toContain('<file path="paper.tex"');
    expect(delivery).toContain(
      'read-path="/executions/abc123/files/paper.tex"',
    );
    expect(delivery).not.toContain('absolute-path=');
  });
});

describe('formatSubagentError', () => {
  // Exact-string pin for the native error shape, byte-identical to the
  // pre-merge output (retryable attr, wall-time, context lines, message last).
  it('pins the exact native error XML', () => {
    const xml = formatSubagentError(
      'abc123',
      'reviewer',
      new Error('subagent exploded <&>'),
      {
        wallTimeMs: 65000,
        workingDirectory: '/ws/project',
        memoryMisses: [
          { path: '/memories/missing.md', reason: 'Path is missing' },
        ],
      },
    );
    expect(xml).toBe(
      [
        '<subagent-error id="abc123" agent="reviewer" retryable="true">',
        '<wall-time>1m 5s</wall-time>',
        '<working-directory>/ws/project</working-directory>',
        '<memory-misses>',
        '<memory-miss path="/memories/missing.md" reason="Path is missing" />',
        '</memory-misses>',
        '<message>subagent exploded &lt;&amp;></message>',
        '</subagent-error>',
      ].join('\n'),
    );
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
      'printf lines',
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
      'printf lines',
      1000,
      { success: true, stdout: '', stderr: '', timedOut: false, exitCode: 0 },
      { tail: 'ok' },
      { tail: '' },
    );
    const error = formatBashError('bash&1"<', 'printf lines', new Error('no'));

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
      'printf lines',
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
