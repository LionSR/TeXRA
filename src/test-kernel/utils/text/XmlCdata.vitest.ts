import { describe, expect, it } from 'vitest';
import { addCdataToTagsMultiple, removeCDATA } from '@utils/text/xmlCdata';

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

  it.each([
    {
      tag: 'document',
      input: '<document><![CDATA[Text with <xml-like> LaTeX</document>',
      expected:
        '<document><![CDATA[<![CDATA[Text with <xml-like> LaTeX]]></document>',
    },
    {
      tag: 'document',
      input:
        '<document name="main.tex"><![CDATA[Text with <xml-like> LaTeX</document>',
      expected:
        '<document name="main.tex"><![CDATA[<![CDATA[Text with <xml-like> LaTeX]]></document>',
    },
  ])(
    'wraps malformed CDATA starts in $tag tags',
    ({ tag, input, expected }) => {
      expect(addCdataToTagsMultiple(input, [tag])).toBe(expected);
    },
  );

  it('removes nested CDATA wrappers left by legacy double-wrapping', () => {
    expect(
      removeCDATA('<![CDATA[<![CDATA[Text with <xml-like> LaTeX]]>]]>'),
    ).toBe('Text with <xml-like> LaTeX');
  });
});
