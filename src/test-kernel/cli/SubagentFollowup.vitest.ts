import { describe, expect, it } from 'vitest';

import {
  decodeXmlEntities,
  deliveryTagOf,
  hasIncompleteEmbeddedSubagentFollowup,
  stripOrchestratorFollowup,
  summarizeEmbeddedSubagentFollowups,
  summarizeFollowupMessage,
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

// XML-escaped workflow-summary JSON for the workflow-script-result/error tests.
function workflowSummary(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: 'proofread-pipeline',
    outcome: 'completed',
    phaseCount: 2,
    taskDone: 4,
    taskTotal: 4,
    costUsd: 0.19,
    durationMs: 724_000,
    files: [
      { path: 'paper_A.tex', added: 120, removed: 80 },
      { path: 'notes.txt', added: null, removed: null },
    ],
    scriptPath: '.texra/workflow-scripts/proofread-pipeline.mjs',
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
      deliveryTagOf('  \n<execution-activity>x</execution-activity>'),
    ).toBe('execution-activity');
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
  it('passes non-subagent text through unchanged', () => {
    expect(summarizeSubagentFollowup('hello world')).toBe('hello world');
    expect(
      summarizeSubagentFollowup(
        '<orchestrator-followup>x</orchestrator-followup>',
      ),
    ).toBe('<orchestrator-followup>x</orchestrator-followup>');
  });

  it('strips orchestrator follow-up wrappers', () => {
    expect(
      stripOrchestratorFollowup(
        '<orchestrator-followup>\nPlease inspect the file.\n</orchestrator-followup>',
      ),
    ).toBe('Please inspect the file.');
    expect(stripOrchestratorFollowup('ordinary user text')).toBe(
      'ordinary user text',
    );
  });

  it('summarizes malformed non-string follow-up payloads without throwing', () => {
    expect(summarizeFollowupMessage(undefined)).toBe('(empty follow-up)');
    expect(summarizeSubagentFollowup(undefined)).toBe('(empty follow-up)');
  });

  it('preserves empty string messages for transcript rendering', () => {
    expect(summarizeFollowupMessage('')).toBe('');
    expect(summarizeSubagentFollowup('')).toBe('');
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

  it('pluralizes tool calls', () => {
    expect(
      summarizeSubagentFollowup(
        '<subagent-progress id="abc" agent="research" type="overview" tool-calls="3" files-changed="none" />',
      ),
    ).toBe('⟳ research · 3 tool calls');
  });

  it('summarizes todo progress attributes', () => {
    expect(
      summarizeSubagentFollowup(
        '<subagent-progress id="abc" agent="review" type="todos" completed="1" active="1" pending="1" />',
      ),
    ).toBe('⟳ review · todos · 1 done, 1 active, 1 pending');
  });

  it('summarizes embedded subagent blocks inside assistant text', () => {
    const text = [
      'before',
      '<subagent-progress id="abc" agent="review" type="started" />',
      '<subagent-progress id="abc" agent="review" type="todos" completed="2" active="1" pending="0" />',
      'after',
    ].join('\n');
    expect(summarizeEmbeddedSubagentFollowups(text)).toBe(
      [
        'before',
        '⟳ review · started',
        '⟳ review · todos · 2 done, 1 active, 0 pending',
        'after',
      ].join('\n'),
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

  it('renders the typed workflow summary instead of its raw run-log tail', () => {
    const xml = [
      '<workflow-script-result id="abc">',
      '<response>result',
      '=== Run log ===',
      'many duplicate lines</response>',
      `<workflow-summary>${workflowSummary()}</workflow-summary>`,
      '</workflow-script-result>',
    ].join('\n');

    expect(summarizeSubagentFollowup(xml)).toBe(
      [
        '✓ proofread-pipeline completed · 2 phases · 4/4 tasks succeeded · $0.190 · 12m 4s',
        '  paper_A.tex (+120 -80)',
        '  notes.txt',
        '  script: .texra/workflow-scripts/proofread-pipeline.mjs',
        '  rerun: edit the script, then call delegate_multi_agents with scriptPath',
      ].join('\n'),
    );
  });

  it('keeps the workflow failure cause but omits its duplicate run log', () => {
    const xml = [
      '<workflow-script-error id="abc">',
      `<workflow-summary>${workflowSummary({
        outcome: 'failed',
        taskDone: 1,
        costUsd: 0.03,
        durationMs: 5_000,
        files: [],
        errorCause: 'Model request failed: quota exhausted',
      })}</workflow-summary>`,
      '<message>Model request failed: quota exhausted',
      '',
      '=== Run log ===',
      'Finished: earlier task',
      '',
      'Script file: .texra/workflow-scripts/proofread-pipeline.mjs</message>',
      '</workflow-script-error>',
    ].join('\n');

    const rendered = summarizeSubagentFollowup(xml);
    expect(rendered).toContain('✗ proofread-pipeline failed');
    expect(rendered).toContain('Model request failed: quota exhausted');
    expect(rendered).not.toContain('=== Run log ===');
    expect(rendered).not.toContain('Finished: earlier task');
  });

  it('preserves structured failure text without parsing generated suffixes', () => {
    const xml = [
      '<workflow-script-error id="abc">',
      `<workflow-summary>${workflowSummary({
        outcome: 'failed',
        phaseCount: 0,
        taskDone: 0,
        taskTotal: 0,
        costUsd: 0,
        durationMs: 100,
        files: [],
        errorCause:
          'Literal &amp;lt;tag&amp;gt;\n\n=== Run log belongs to the error\nScript file: user note',
      })}</workflow-summary>`,
      '<message>=== Run log ===',
      'generated entry',
      '',
      'Script file: .texra/workflow-scripts/proofread-pipeline.mjs</message>',
      '</workflow-script-error>',
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

  it('summarizes wrapped result follow-up messages for queued displays', () => {
    const xml = [
      '<orchestrator-followup>',
      '<subagent-result id="abc" agent="reviewer" category="toolUse" status="completed">',
      '<response>All good &lt;ok&gt;</response>',
      '</subagent-result>',
      '</orchestrator-followup>',
    ].join('');
    expect(summarizeFollowupMessage(xml)).toBe(
      '✓ reviewer completed\nAll good <ok>',
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

  it('summarizes a background-result block, falling back to the tag family name', () => {
    const xml = [
      '<background-result id="abc" command="npm test">',
      '<wall-time>3sec</wall-time>',
      '</background-result>',
    ].join('\n');
    expect(summarizeSubagentFollowup(xml)).toBe(
      '✓ background completed · 3sec',
    );
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

  it('summarizes an execution-activity block as its first body line', () => {
    const xml =
      '<execution-activity>\nexec-1 (research, toolUse) running → completed\n</execution-activity>';
    expect(summarizeSubagentFollowup(xml)).toBe(
      'exec-1 (research, toolUse) running → completed',
    );
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
