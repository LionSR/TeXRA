// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { formatDelivery } from '@agent/runtime/deliveryEnvelope';

// formatDelivery is the one builder behind every child-run delivery: the
// native subagent path, the background-bash path, workflow scripts, and the
// agent-CLI tools (codex.ts, claudeAgent.ts).

describe('formatDelivery', () => {
  it('truncates the echoed prompt to 200 chars and escapes attrs/text', () => {
    const longPrompt = 'x'.repeat(250);
    const xml = formatDelivery({
      tag: 'codex-result',
      runId: 'a&b"<c',
      prompt: `${longPrompt}<&"`,
      attributes: [{ name: 'thread-id', value: '<id&"' }],
      wallTime: '0.1s',
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
