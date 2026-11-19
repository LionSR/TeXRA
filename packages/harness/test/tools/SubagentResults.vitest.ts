// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { formatDelivery } from '@agent/runtime/deliveryEnvelope';

// formatDelivery is the one renderer of every child-run delivery: the
// native subagent path, the background-bash path, workflow scripts, and the
// agent-CLI tools (codex.ts, claudeAgent.ts).

describe('formatDelivery', () => {
  it('escapes attrs and text and words the wall time', () => {
    const xml = formatDelivery({
      family: 'codex',
      runId: 'a&b"<c',
      attributes: [
        { name: 'prompt', value: 'fix <&">' },
        { name: 'thread-id', value: '<id&"' },
      ],
      wallTimeMs: 100,
      response: 'a < b & c "q"',
    });
    // id and attributes are attribute-escaped (&, ", < — not >).
    expect(xml).toContain(
      '<codex-result id="a&amp;b&quot;&lt;c" prompt="fix &lt;&amp;&quot;>" thread-id="&lt;id&amp;&quot;">',
    );
    expect(xml).toContain('<wall-time>0.1s</wall-time>');
    // response is text-escaped (&, < — quotes left intact)
    expect(xml).toContain('<response>a &lt; b &amp; c "q"</response>');
  });
});
