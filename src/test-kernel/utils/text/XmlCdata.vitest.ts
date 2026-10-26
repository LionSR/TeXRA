import { describe, expect, it } from 'vitest';
import { addCdataToTagsMultiple } from '@texra/utils/text/xmlCdata';

describe('xmlCdata CDATA handling', () => {
  it.each([
    {
      tag: 'document',
      input:
        '<document><![CDATA[Text with <xml-like> LaTeX & comments]]></document>',
    },
    {
      tag: 'document',
      input:
        '<document name="main.tex"><![CDATA[Text with <xml-like> LaTeX & comments]]></document>',
    },
  ])(
    'does not double-wrap $tag content that is already CDATA-wrapped',
    ({ tag, input }) => {
      expect(addCdataToTagsMultiple(input, [tag])).toBe(input);
    },
  );
});
