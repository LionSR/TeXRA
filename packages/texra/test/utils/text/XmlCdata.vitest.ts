import { describe, expect, it } from 'vitest';
import { addCdataToTagsMultiple } from '@texra/utils/text/xmlCdata';

describe('xmlCdata CDATA handling', () => {
  it('does not double-wrap content that is already CDATA-wrapped', () => {
    const input =
      '<document name="main.tex"><![CDATA[Text with <xml-like> LaTeX & comments]]></document>';
    expect(addCdataToTagsMultiple(input, ['document'])).toBe(input);
  });
});
