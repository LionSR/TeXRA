import { describe, expect, it } from 'vitest';

import {
  stripOrchestratorFollowup,
  summarizeEmbeddedSubagentFollowups,
  summarizeFollowupMessage,
  summarizeSubagentFollowup,
} from '@shared/subagentFollowup';

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

  it('summarizes a round progress block', () => {
    expect(
      summarizeSubagentFollowup(
        '<subagent-progress id="abc" agent="numerics" type="round" current="2" total="5">\n<file path="a.tex" />\n</subagent-progress>',
      ),
    ).toBe('⟳ numerics · round 2/5');
  });

  it('summarizes todo progress blocks that carry JSON bodies', () => {
    const xml = [
      '<subagent-progress id="abc" agent="review" type="todos">',
      '[',
      '{"content":"done","status":"completed"},',
      '{"content":"active","status":"in_progress"},',
      '{"content":"todo","status":"pending"}',
      ']',
      '</subagent-progress>',
    ].join('');
    expect(summarizeSubagentFollowup(xml)).toBe(
      '⟳ review · todos · 1 done, 1 active, 1 pending',
    );
  });

  it('summarizes embedded subagent blocks inside assistant text', () => {
    const text = [
      'before',
      '<subagent-progress id="abc" agent="review" type="started" />',
      '<subagent-progress id="abc" agent="review" type="conversations" turns="4" characters="4471">',
      'Last message',
      '</subagent-progress>',
      '<subagent-progress id="abc" agent="review" type="round" current="2" total="3">',
      '<file path="a.tex" />',
      '</subagent-progress>',
      'after',
    ].join('\n');
    expect(summarizeEmbeddedSubagentFollowups(text)).toBe(
      [
        'before',
        '⟳ review · started',
        '⟳ review · conversation · 4 turns · 4471 chars',
        '⟳ review · round 2/3',
        'after',
      ].join('\n'),
    );
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
});
