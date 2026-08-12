// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import type { AgentFinalResult } from '@agent/runtime/AgentFinalResult';
import { RUN_OUTCOME } from '@shared/schemas';
import {
  formatChildRunDelivery,
  formatChildRunError,
} from '@tools/delegation/deliveryEnvelope';
import {
  formatBashDelivery,
  formatBashError,
} from '@tools/delegation/bashDelivery';
import {
  formatSubagentDelivery,
  formatSubagentError,
} from '@tools/delegation/subagentResults';
import { toErrorMessage } from '@utils/errors/errorMessage';

function toolUseResult(
  outcome: AgentFinalResult['outcome'] = RUN_OUTCOME.COMPLETED,
  overrides: Partial<Extract<AgentFinalResult, { category: 'toolUse' }>> = {},
): Extract<AgentFinalResult, { category: 'toolUse' }> {
  return {
    category: 'toolUse',
    outcome,
    response: '',
    files: [],
    cost: 0,
    ...overrides,
  };
}

function workflowResult(
  overrides: Partial<Extract<AgentFinalResult, { category: 'workflow' }>> = {},
): Extract<AgentFinalResult, { category: 'workflow' }> {
  return {
    category: 'workflow',
    outcome: RUN_OUTCOME.COMPLETED,
    outputs: [],
    compileFailures: [],
    diffs: [],
    cost: 0,
    ...overrides,
  };
}

function seconds(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

// formatChildRunDelivery/formatChildRunError are the one result/error builder
// family for every child-run delivery: the native subagent path
// (formatSubagentDelivery/formatSubagentError) and the agent-CLI tools
// (codex.ts, claudeAgent.ts). The cases below replay the exact parameter
// mappings used at the real call sites; the expected strings are
// byte-identical to what the pre-merge agent-CLI formatters
// (formatAgentCliDelivery/formatAgentCliError) produced.

describe('formatChildRunDelivery', () => {
  it('renders the codex shape: thread-id attr, raw usage, no cost line', () => {
    const xml = formatChildRunDelivery(
      {
        tag: 'codex-result',
        executionId: 'exec-1',
        prompt: 'do the thing',
        attributes: [{ name: 'thread-id', value: 'th-42' }],
      },
      {
        wallTime: seconds(1234),
        response: 'all done',
        usage: { input: 100, output: 20 },
      },
    );
    expect(xml).toBe(
      [
        '<codex-result id="exec-1" prompt="do the thing" thread-id="th-42">',
        '<wall-time>1.2s</wall-time>',
        '<response>all done</response>',
        '<usage input="100" output="20" />',
        '</codex-result>',
      ].join('\n'),
    );
  });

  it('renders the claude shape: session-id attr and a cost extra line', () => {
    const xml = formatChildRunDelivery(
      {
        tag: 'claude-agent-result',
        executionId: 'exec-2',
        prompt: 'summarize',
        attributes: [{ name: 'session-id', value: 'sess-7' }],
      },
      {
        wallTime: seconds(9000),
        response: 'summary',
        usage: { input: 5, output: 0 },
        lines: ['<cost-usd>0.1234</cost-usd>'],
      },
    );
    expect(xml).toBe(
      [
        '<claude-agent-result id="exec-2" prompt="summarize" session-id="sess-7">',
        '<wall-time>9.0s</wall-time>',
        '<response>summary</response>',
        '<usage input="5" output="0" />',
        '<cost-usd>0.1234</cost-usd>',
        '</claude-agent-result>',
      ].join('\n'),
    );
  });

  it('omits the provider id attribute (thread-id), usage, and extra lines when absent/falsy', () => {
    const xml = formatChildRunDelivery(
      {
        tag: 'codex-result',
        executionId: 'exec-3',
        prompt: 'p',
        attributes: [{ name: 'thread-id', value: null }],
      },
      { wallTime: seconds(0), response: 'r', usage: null },
    );
    expect(xml).toBe(
      [
        '<codex-result id="exec-3" prompt="p">',
        '<wall-time>0.0s</wall-time>',
        '<response>r</response>',
        '</codex-result>',
      ].join('\n'),
    );
  });

  it('falls back to "(no response)" for an empty response', () => {
    const xml = formatChildRunDelivery(
      { tag: 'codex-result', executionId: 'e', prompt: 'p' },
      { wallTime: seconds(500), response: '' },
    );
    expect(xml).toContain('<response>(no response)</response>');
  });

  it('truncates the echoed prompt to 200 chars and escapes attrs/text', () => {
    const longPrompt = 'x'.repeat(250);
    const xml = formatChildRunDelivery(
      {
        tag: 'codex-result',
        executionId: 'a&b"<c',
        prompt: `${longPrompt}<&"`,
        attributes: [{ name: 'thread-id', value: '<id&"' }],
      },
      { wallTime: seconds(100), response: 'a < b & c "q"' },
    );
    // id/prompt/thread-id are attribute-escaped (&, ", < — not >); the prompt is
    // sliced to 200 chars BEFORE escaping, so the trailing <&" never appears.
    expect(xml).toContain(
      `<codex-result id="a&amp;b&quot;&lt;c" prompt="${'x'.repeat(200)}" thread-id="&lt;id&amp;&quot;">`,
    );
    // response is text-escaped (&, < — quotes left intact)
    expect(xml).toContain('<response>a &lt; b &amp; c "q"</response>');
  });
});

describe('formatChildRunError', () => {
  it('renders the error shape, escaping attrs and the message body', () => {
    const xml = formatChildRunError(
      { tag: 'codex-error', executionId: 'exec-1', prompt: 'why did it fail?' },
      { message: toErrorMessage(new Error('boom <&>')) },
    );
    expect(xml).toBe(
      [
        '<codex-error id="exec-1" prompt="why did it fail?">',
        // toErrorMessage(Error) -> message; escapeText escapes & and < (not >)
        '<message>boom &lt;&amp;></message>',
        '</codex-error>',
      ].join('\n'),
    );
  });

  it('uses the provided tag and stringifies non-Error values', () => {
    const xml = formatChildRunError(
      { tag: 'claude-agent-error', executionId: 'e', prompt: 'p' },
      { message: toErrorMessage('plain') },
    );
    expect(xml).toBe(
      [
        '<claude-agent-error id="e" prompt="p">',
        '<message>plain</message>',
        '</claude-agent-error>',
      ].join('\n'),
    );
  });
});

describe('formatSubagentDelivery', () => {
  // Exact-string pin for the native tool-use delivery shape, byte-identical
  // to the pre-merge output (wall-time first, then working-directory,
  // memory-misses, and the three-line response block).
  it('pins the exact native tool-use delivery XML', () => {
    const xml = formatSubagentDelivery(
      'reviewer',
      toolUseResult(RUN_OUTCOME.COMPLETED, {
        response: 'Checked the proof & wrote <notes>.',
        files: ['/ws/paper.tex'],
      }),
      {
        executionId: 'abc123',
        memoryMisses: [
          { path: '/memories/missing.md', reason: 'Path is missing' },
        ],
        wallTimeMs: 65000,
        workingDirectory: '/ws/project',
      },
    );
    expect(xml).toBe(
      [
        '<subagent-result id="abc123" agent="reviewer" category="toolUse" status="completed">',
        '<wall-time>1m 5s</wall-time>',
        '<working-directory>/ws/project</working-directory>',
        '<memory-misses>',
        '<memory-miss path="/memories/missing.md" reason="Path is missing" />',
        '</memory-misses>',
        '<response>',
        'Checked the proof &amp; wrote &lt;notes>.',
        '</response>',
        '<touched-files>',
        '<file path="/ws/paper.tex" />',
        '</touched-files>',
        '</subagent-result>',
      ].join('\n'),
    );
  });

  it('escapes tool-use response bodies at the XML boundary', () => {
    const result = toolUseResult(RUN_OUTCOME.COMPLETED, {
      response: 'Keep </response> literal & preserve <subagent-result> text.',
    });

    const delivery = formatSubagentDelivery('reviewer', result, {
      executionId: 'abc123',
    });

    expect(delivery).toContain(
      'Keep &lt;/response> literal &amp; preserve &lt;subagent-result> text.',
    );
    expect(delivery).not.toContain('Keep </response> literal');
  });

  it('includes attached memory misses in subagent delivery XML', () => {
    const result = toolUseResult(RUN_OUTCOME.COMPLETED, {
      response: 'Checked the proof.',
    });

    const delivery = formatSubagentDelivery('reviewer', result, {
      executionId: 'abc123',
      memoryMisses: [
        {
          path: '/memories/missing.md',
          reason: 'Path is missing & unreadable',
        },
      ],
    });

    expect(delivery).toContain('<memory-misses>');
    expect(delivery).toContain(
      '<memory-miss path="/memories/missing.md" reason="Path is missing &amp; unreadable" />',
    );
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
      executionId: 'abc123',
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

  it('omits the diffs-unavailable element on clean deliveries', () => {
    expect(
      formatSubagentDelivery('polish', workflowResult(), {
        executionId: 'abc123',
      }),
    ).not.toContain('diffs-unavailable');
  });

  it('emits canonical failed and cancelled statuses for orchestrators', () => {
    expect(
      formatSubagentDelivery('reviewer', toolUseResult(RUN_OUTCOME.FAILED), {
        executionId: 'abc123',
      }),
    ).toContain('status="failed"');
    expect(
      formatSubagentDelivery('reviewer', toolUseResult(RUN_OUTCOME.CANCELLED), {
        executionId: 'abc123',
      }),
    ).toContain('status="cancelled"');
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
      { success: true, stdout: '', stderr: '', exitCode: 0 },
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
      { success: true, stdout: '', stderr: '', exitCode: 0 },
      { tail: 'ok' },
      { tail: '' },
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
      { tail: 'tail output', head: 'first fatal error', elidedChars: 500 },
      { tail: 'tail stderr', head: 'first fatal stderr', elidedChars: 250 },
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
      { tail: 'ok' },
      { tail: '' },
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
      { tail: `${outputTail}\r\n` },
      { tail: '' },
    );

    expect(delivery).not.toContain('line-01');
    expect(delivery).toContain('line-02');
    expect(delivery).toContain('line-21');
    expect(delivery).not.toContain('\r');
  });
});
