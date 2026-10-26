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

  // Recognizer is derived from @shared/deliveryTags' DELIVERY_TAGS (11
  // entries), not just `<subagent-*>` — regression coverage for
  // claude-agent-result/error and codex-result/error leaking as raw XML in
  // the CLI transcript/queued follow-ups panel (codex review, issue #7679).
  // One case per newly-recognized tag family.

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
