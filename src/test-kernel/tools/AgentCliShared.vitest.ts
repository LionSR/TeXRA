// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - tools
import {
  formatAgentCliDelivery,
  formatAgentCliError,
} from '@tools/agentCliShared';

// These helpers are the single source of truth for the XML delivered to a
// parent's follow-up queue when a codex/claude agent-CLI turn completes. The
// cases below pin the exact output for both provider shapes (the parameter
// mappings used at the real call sites in codex.ts / claudeAgent.ts) plus the
// edge cases the conditional emission depends on.

describe('formatAgentCliDelivery', () => {
  it('renders the codex shape: thread-id attr, raw usage, no cost line', () => {
    const xml = formatAgentCliDelivery({
      tag: 'codex-result',
      executionId: 'exec-1',
      prompt: 'do the thing',
      wallTimeMs: 1234,
      response: 'all done',
      idAttr: { name: 'thread-id', value: 'th-42' },
      usage: { input: 100, output: 20 },
    });
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
    const xml = formatAgentCliDelivery({
      tag: 'claude-agent-result',
      executionId: 'exec-2',
      prompt: 'summarize',
      wallTimeMs: 9000,
      response: 'summary',
      idAttr: { name: 'session-id', value: 'sess-7' },
      usage: { input: 5, output: 0 },
      extraLines: ['<cost-usd>0.1234</cost-usd>'],
    });
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

  it('omits the id attribute, usage, and extra lines when absent/falsy', () => {
    const xml = formatAgentCliDelivery({
      tag: 'codex-result',
      executionId: 'exec-3',
      prompt: 'p',
      wallTimeMs: 0,
      response: 'r',
      idAttr: { name: 'thread-id', value: null },
      usage: null,
    });
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
    const xml = formatAgentCliDelivery({
      tag: 'codex-result',
      executionId: 'e',
      prompt: 'p',
      wallTimeMs: 500,
      response: '',
    });
    expect(xml).toContain('<response>(no response)</response>');
  });

  it('truncates the echoed prompt to 200 chars and escapes attrs/text', () => {
    const longPrompt = 'x'.repeat(250);
    const xml = formatAgentCliDelivery({
      tag: 'codex-result',
      executionId: 'a&b"<c',
      prompt: `${longPrompt}<&"`,
      wallTimeMs: 100,
      response: 'a < b & c "q"',
      idAttr: { name: 'thread-id', value: '<id&"' },
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

describe('formatAgentCliError', () => {
  it('renders the error shape, escaping attrs and the message body', () => {
    const xml = formatAgentCliError(
      'codex-error',
      'exec-1',
      'why did it fail?',
      new Error('boom <&>'),
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
    const xml = formatAgentCliError('claude-agent-error', 'e', 'p', 'plain');
    expect(xml).toBe(
      [
        '<claude-agent-error id="e" prompt="p">',
        '<message>plain</message>',
        '</claude-agent-error>',
      ].join('\n'),
    );
  });
});
