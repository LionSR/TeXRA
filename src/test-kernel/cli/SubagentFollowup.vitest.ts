import { describe, expect, it } from 'vitest';

import {
  decodeXmlEntities,
  deliveryTagOf,
  hasIncompleteEmbeddedSubagentFollowup,
  summarizeEmbeddedSubagentFollowups,
  summarizeSubagentFollowup,
} from '@shared/subagentFollowup';

// Incomplete-delivery fixtures shared by the summarize/detect pairs below.
const PROVER_STREAMING_TEXT = [
  'before',
  '<subagent-result id="abc" agent="prover" category="toolUse" status="completed">',
  'The response is still streaming.',
].join('\n');
const CODEX_STREAMING_TEXT = [
  'before',
  '<codex-result id="abc" thread-id="t1">',
  'The response is still streaming.',
].join('\n');

// XML-escaped script-summary JSON for the script-result/error tests.
function tally(ok: number, failed = 0): Record<string, number> {
  return {
    total: ok + failed,
    ok,
    failed,
    cancelled: 0,
    skipped: 0,
  };
}

function scriptSummary(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: 'proofread-pipeline',
    outcome: 'completed',
    phaseCount: 2,
    tally: tally(4),
    costUsd: 0.19,
    durationMs: 724_000,
    files: [
      { path: 'paper_A.tex', added: 120, removed: 80 },
      { path: 'notes.txt', added: null, removed: null },
    ],
    errorCause: null,
    ...overrides,
  }).replaceAll('"', '&quot;');
}

describe('deliveryTagOf', () => {
  it('recognizes every envelope opening a render surface can receive', () => {
    expect(
      deliveryTagOf('<subagent-result agent="a">x</subagent-result>'),
    ).toBe('subagent-result');
    expect(
      deliveryTagOf('  \n<github-webhook-activity>x</github-webhook-activity>'),
    ).toBe('github-webhook-activity');
    expect(deliveryTagOf('<claude-agent-error />')).toBe('claude-agent-error');
    expect(deliveryTagOf('<codex-result/>')).toBe('codex-result');
  });

  it('rejects text that only resembles an envelope', () => {
    expect(deliveryTagOf('hello world')).toBeUndefined();
    expect(
      deliveryTagOf('<codex-result-partial>x</codex-result-partial>'),
    ).toBeUndefined();
    expect(
      deliveryTagOf('prose then <subagent-result>x</subagent-result>'),
    ).toBeUndefined();
  });
});

describe('summarizeSubagentFollowup', () => {
  it('summarizes malformed non-string follow-up payloads without throwing', () => {
    expect(summarizeSubagentFollowup(undefined)).toBe('(empty follow-up)');
  });

  it('summarizes a started progress block', () => {
    expect(
      summarizeSubagentFollowup(
        '<subagent-progress id="abc" agent="research" type="started" />',
      ),
    ).toBe('⟳ research · started');
  });

  it('summarizes an overview progress block with tool calls and cost', () => {
    expect(
      summarizeSubagentFollowup(
        '<subagent-progress id="abc" agent="research" type="overview" tool-calls="1" files-changed="none" cost="0.0007" />',
      ),
    ).toBe('⟳ research · 1 tool call · $0.0007');
  });

  it.each([
    '<subagent-progress agent="a" />',
    '<subagent-progress agent="a" type="bogus" />',
    '<subagent-progress agent="a" type="overview" />',
    '<subagent-progress agent="a" type="plan" status="updated" />',
    '<subagent-progress agent="a" type="todos" completed="1" active="0" pending="0" />',
    '<subagent-progress agent="a" tool-type="started" />',
  ])('preserves a non-canonical progress block: %s', (xml) => {
    expect(summarizeSubagentFollowup(xml)).toBe(xml);
  });

  it.each([
    [
      '<subagent-progress agent="a" type="plan" status="cleared" />',
      '⟳ a · plan cleared',
    ],
    [
      '<subagent-progress agent="a" type="plan" status="updated" summary="Build the proof" />',
      '⟳ a · plan · Build the proof',
    ],
  ])('summarizes a canonical plan progress block', (xml, expected) => {
    expect(summarizeSubagentFollowup(xml)).toBe(expected);
  });

  it('summarizes embedded subagent blocks inside assistant text', () => {
    const text = [
      'before',
      '<subagent-progress id="abc" agent="review" type="started" />',
      '<subagent-progress id="abc" agent="review" type="plan" status="cleared" />',
      'after',
    ].join('\n');
    expect(summarizeEmbeddedSubagentFollowups(text)).toBe(
      ['before', '⟳ review · started', '⟳ review · plan cleared', 'after'].join(
        '\n',
      ),
    );
  });

  it('summarizes incomplete embedded subagent blocks while streaming', () => {
    expect(summarizeEmbeddedSubagentFollowups(PROVER_STREAMING_TEXT)).toBe(
      ['before', '✓ prover completed'].join('\n'),
    );
  });

  it('detects incomplete embedded subagent blocks', () => {
    expect(hasIncompleteEmbeddedSubagentFollowup(PROVER_STREAMING_TEXT)).toBe(
      true,
    );
    expect(
      hasIncompleteEmbeddedSubagentFollowup(
        [
          'before',
          '<subagent-result id="abc" agent="prover" category="toolUse" status="completed">',
          '<response>Done.</response>',
          '</subagent-result>',
        ].join('\n'),
      ),
    ).toBe(false);
    expect(
      hasIncompleteEmbeddedSubagentFollowup(
        '<subagent-progress id="abc" agent="review" type="started" />',
      ),
    ).toBe(false);
  });

  // Embedded-block recognizer (EMBEDDED_DELIVERY_BLOCK_RE /
  // EMBEDDED_DELIVERY_OPEN_RE) is derived from the same DELIVERY_TAGS
  // vocabulary as SUBAGENT_TAG_RE, not just `<subagent-*>` — regression
  // coverage for a non-`subagent` family (`codex-result`) leaking as raw XML
  // when embedded mid-stream in assistant text (issue #7846, follow-up to
  // #7679/#7788).

  it('summarizes an embedded codex-result block inside assistant text', () => {
    const text = [
      'before',
      '<codex-result id="abc" thread-id="t1">',
      '<wall-time>4sec</wall-time>',
      '<response>Refactor complete.</response>',
      '</codex-result>',
      'after',
    ].join('\n');
    expect(summarizeEmbeddedSubagentFollowups(text)).toBe(
      ['before', '✓ codex completed · 4sec\nRefactor complete.', 'after'].join(
        '\n',
      ),
    );
  });

  it('summarizes an incomplete embedded codex-result block while streaming', () => {
    expect(summarizeEmbeddedSubagentFollowups(CODEX_STREAMING_TEXT)).toBe(
      ['before', '✓ codex completed'].join('\n'),
    );
  });

  it('detects incomplete embedded codex-result blocks', () => {
    expect(hasIncompleteEmbeddedSubagentFollowup(CODEX_STREAMING_TEXT)).toBe(
      true,
    );
    expect(
      hasIncompleteEmbeddedSubagentFollowup(
        [
          'before',
          '<codex-result id="abc" thread-id="t1">',
          '<response>Done.</response>',
          '</codex-result>',
        ].join('\n'),
      ),
    ).toBe(false);
  });

  it('summarizes a completed result with wall time and response', () => {
    const xml = [
      '<subagent-result id="abc" agent="research" category="toolUse" status="completed">',
      '<wall-time>2sec</wall-time>',
      '<response>',
      '91 .ts files found.',
      '</response>',
      '</subagent-result>',
    ].join('\n');
    expect(summarizeSubagentFollowup(xml)).toBe(
      '✓ research completed · 2sec\n91 .ts files found.',
    );
  });

  it('decodes escaped result responses for display', () => {
    const xml = [
      '<subagent-result id="abc" agent="research" category="toolUse" status="completed">',
      '<response>Keep &lt;/response> literal &amp; inspect &lt;file&gt;</response>',
      '</subagent-result>',
    ].join('\n');
    expect(summarizeSubagentFollowup(xml)).toBe(
      '✓ research completed\nKeep </response> literal & inspect <file>',
    );
  });

  it('renders the typed script summary instead of its raw run-log tail', () => {
    const xml = [
      '<script-result id="abc">',
      '<response>result',
      '=== Run log ===',
      'many duplicate lines</response>',
      `<script-summary>${scriptSummary()}</script-summary>`,
      '</script-result>',
    ].join('\n');

    expect(summarizeSubagentFollowup(xml)).toBe(
      [
        '✓ proofread-pipeline completed · 2 phases · 4 ok · $0.190 · 12m 4s',
        '  paper_A.tex (+120 -80)',
        '  notes.txt',
      ].join('\n'),
    );
  });

  it('keeps the script failure cause but omits its duplicate run log', () => {
    const xml = [
      '<script-error id="abc">',
      `<script-summary>${scriptSummary({
        outcome: 'failed',
        tally: tally(1, 3),
        costUsd: 0.03,
        durationMs: 5_000,
        files: [],
        errorCause: 'Model request failed: quota exhausted',
      })}</script-summary>`,
      '<message>Model request failed: quota exhausted',
      '',
      '=== Run log ===',
      'Finished: earlier task',
      '',
      'Script file: .texra/workflow-scripts/proofread-pipeline.mjs</message>',
      '</script-error>',
    ].join('\n');

    const rendered = summarizeSubagentFollowup(xml);
    expect(rendered).toContain(
      '✗ proofread-pipeline failed · 2 phases · 1 ok · 3 failed',
    );
    expect(rendered).toContain('Model request failed: quota exhausted');
    expect(rendered).not.toContain('=== Run log ===');
    expect(rendered).not.toContain('Finished: earlier task');
  });

  it('preserves structured failure text without parsing generated suffixes', () => {
    const xml = [
      '<script-error id="abc">',
      `<script-summary>${scriptSummary({
        outcome: 'failed',
        phaseCount: 0,
        tally: tally(0),
        costUsd: 0,
        durationMs: 100,
        files: [],
        errorCause:
          'Literal &amp;lt;tag&amp;gt;\n\n=== Run log belongs to the error\nScript file: user note',
      })}</script-summary>`,
      '<message>=== Run log ===',
      'generated entry',
      '',
      'Script file: .texra/workflow-scripts/proofread-pipeline.mjs</message>',
      '</script-error>',
    ].join('\n');

    const rendered = summarizeSubagentFollowup(xml);
    expect(rendered).toContain('Literal &lt;tag&gt;');
    expect(rendered).toContain('=== Run log belongs to the error');
    expect(rendered).toContain('Script file: user note');
    expect(rendered).not.toContain('generated entry');
  });

  it('decodes only XML entities in a single pass', () => {
    expect(decodeXmlEntities('&quot;&apos;&lt;&gt;&amp;')).toBe('"\'<>&');
    expect(decodeXmlEntities('&amp;lt;')).toBe('&lt;');
    expect(decodeXmlEntities('&copy; &#39;')).toBe('&copy; &#39;');
  });

  it('previews long result responses without flooding the transcript', () => {
    const response = Array.from(
      { length: 20 },
      (_, index) => `result line ${index + 1}`,
    ).join('\n');
    const xml = [
      '<subagent-result id="abc" agent="prover" category="toolUse" status="completed">',
      '<wall-time>2m</wall-time>',
      '<response>',
      response,
      '</response>',
      '</subagent-result>',
    ].join('\n');

    const summary = summarizeSubagentFollowup(xml);

    expect(summary).toContain('✓ prover completed · 2m');
    expect(summary).toContain('result line 12');
    expect(summary).not.toContain('result line 13');
    expect(summary).toContain(
      '… 8 more lines; open the subagent transcript for the full response',
    );
  });

  it('summarizes a result without a response body', () => {
    expect(
      summarizeSubagentFollowup(
        '<subagent-result id="abc" agent="review" category="toolUse" status="stopped"><wall-time>5sec</wall-time></subagent-result>',
      ),
    ).toBe('✓ review stopped · 5sec');
  });

  it('summarizes a retryable error block without a message', () => {
    expect(
      summarizeSubagentFollowup(
        '<subagent-error id="abc" agent="lean" retryable="true"><wall-time>1sec</wall-time></subagent-error>',
      ),
    ).toBe('✗ lean failed · 1sec (retryable)');
  });

  it('preserves and decodes the error message', () => {
    expect(
      summarizeSubagentFollowup(
        '<subagent-error id="abc" agent="lean" retryable="false"><wall-time>1sec</wall-time><message>rate limit: &lt;tokens&gt; &amp; retries exhausted</message></subagent-error>',
      ),
    ).toBe('✗ lean failed · 1sec\nrate limit: <tokens> & retries exhausted');
  });

  // Recognizer is derived from @shared/deliveryTags' DELIVERY_TAGS (11
  // entries), not just `<subagent-*>` — regression coverage for
  // claude-agent-result/error and codex-result/error leaking as raw XML in
  // the CLI transcript/queued follow-ups panel (codex review, issue #7679).
  // One case per newly-recognized tag family.

  it('summarizes a background-result block by its command and exit code', () => {
    const block = (exitCode: number) =>
      [
        '<background-result id="abc" command="npm test &amp;&amp; lint">',
        `<exit-code>${exitCode}</exit-code>`,
        '<wall-time>3sec</wall-time>',
        '</background-result>',
      ].join('\n');
    expect(summarizeSubagentFollowup(block(0))).toBe(
      '✓ $ npm test && lint · 3sec',
    );
    expect(summarizeSubagentFollowup(block(1))).toBe(
      '✗ $ npm test && lint · exit 1 · 3sec',
    );
    expect(
      summarizeSubagentFollowup(
        block(0).replace(' command=', ' description="Run the checks" command='),
      ),
    ).toBe('✓ Run the checks · 3sec');
    // A timeout's exit code is synthetic: the summary names the timeout.
    expect(
      summarizeSubagentFollowup(
        block(1).replace(
          '<wall-time>',
          '<timed-out>true</timed-out>\n<wall-time>',
        ),
      ),
    ).toBe('✗ $ npm test && lint · timed out · 3sec');
    // Model-written labels reach terminals: an escape sequence is defused.
    expect(
      summarizeSubagentFollowup(
        block(0).replace(
          ' command=',
          ' description="\u001b[2JRun the checks" command=',
        ),
      ),
    ).toBe('✓ [2JRun the checks · 3sec');
  });

  it('summarizes a codex-result block without an agent attribute', () => {
    const xml = [
      '<codex-result id="abc" thread-id="t1">',
      '<wall-time>4sec</wall-time>',
      '<response>Refactor complete.</response>',
      '</codex-result>',
    ].join('\n');
    expect(summarizeSubagentFollowup(xml)).toBe(
      '✓ codex completed · 4sec\nRefactor complete.',
    );
  });

  it('summarizes a claude-agent-error block without an agent attribute', () => {
    const xml = [
      '<claude-agent-error id="abc">',
      '<message>Provider returned 500 &amp; retried</message>',
      '</claude-agent-error>',
    ].join('\n');
    expect(summarizeSubagentFollowup(xml)).toBe(
      '✗ claude-agent failed\nProvider returned 500 & retried',
    );
  });

  it('summarizes a github-webhook-activity block as its first body line', () => {
    const xml =
      '<github-webhook-activity>\nPR #42 opened by octocat\n</github-webhook-activity>';
    expect(summarizeSubagentFollowup(xml)).toBe('PR #42 opened by octocat');
  });

  it('does not prefix-match invalid tag-name continuations', () => {
    for (const continuation of ['-partial', '/foo']) {
      const fakeTag = `codex-result${continuation}`;
      const standalone = `<${fakeTag} id="abc"><response>fake</response></${fakeTag}>`;
      expect(summarizeSubagentFollowup(standalone)).toBe(standalone);

      const embedded = [
        'before',
        `<${fakeTag} id="abc">`,
        'still streaming, not a real delivery tag',
      ].join('\n');
      expect(hasIncompleteEmbeddedSubagentFollowup(embedded)).toBe(false);
      expect(summarizeEmbeddedSubagentFollowups(embedded)).toBe(embedded);
    }
  });
});
