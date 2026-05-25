import { describe, expect, it } from 'vitest';

import { summarizeSubagentFollowup } from '../../../packages/cli/src/chat/tui/state/subagentFollowup';

describe('summarizeSubagentFollowup', () => {
  it('passes non-subagent text through unchanged', () => {
    expect(summarizeSubagentFollowup('hello world')).toBe('hello world');
    expect(
      summarizeSubagentFollowup(
        '<orchestrator-followup>x</orchestrator-followup>',
      ),
    ).toBe('<orchestrator-followup>x</orchestrator-followup>');
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
