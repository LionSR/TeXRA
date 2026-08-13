// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Local imports
import { parseEml } from '@tools/emlParser';

const HTML_ONLY_EML = `From: Alice <alice@example.com>
To: Bob <bob@example.com>
Subject: Test
Content-Type: text/html; charset=utf-8

<html><head><style>.x{color:red}</style></head><body>
<p>Hello <b>world</b>,</p>
<ul><li>Item one</li><li>Item two</li></ul>
<p>See <a href="https://example.com">this link</a>.</p>
<p>Curly quote: it&#8217;s here.</p>
<script>alert('x')</script>
</body></html>
`;

describe('parseEml', () => {
  it('converts an HTML-only body to Markdown without leaking style/script content', async () => {
    const { text } = await parseEml(HTML_ONLY_EML);

    assert.match(text, /Hello \*\*world\*\*,/);
    assert.match(text, /Item one/);
    assert.match(text, /Item two/);
    assert.match(text, /\[this link\]\(https:\/\/example\.com\)/);
    // Numeric entity (&#8217;) decodes to a curly apostrophe.
    assert.match(text, /it’s here/);

    assert.doesNotMatch(text, /color:red/);
    assert.doesNotMatch(text, /alert\(/);
  });
});
