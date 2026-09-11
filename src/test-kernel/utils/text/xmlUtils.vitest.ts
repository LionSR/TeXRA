import { describe, expect, it, vi } from 'vitest';
import { addCdataToTagsMultiple, removeCDATA } from '@utils/text/xmlCdata';
import { formatContent } from '@utils/text/xmlConversion';
import { extractScratchpad } from '@utils/text/xmlExtraction';

// Pin the deterministic Turndown/regex fallback path: Pandoc availability is
// environment-dependent, so the conversion tests below would otherwise assert
// different output depending on whether `pandoc` happens to be installed.
vi.mock('@utils/system/toolUtils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@utils/system/toolUtils')>()),
  checkToolInstalled: async () => false,
}));

describe('xmlUtils CDATA handling', () => {
  it.each([
    {
      tag: 'latex_document',
      input:
        '<latex_document><![CDATA[Text with <xml-like> LaTeX & comments]]></latex_document>',
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
      tag: 'latex_document',
      input:
        '<latex_document><![CDATA[Text with <xml-like> LaTeX</latex_document>',
      expected:
        '<latex_document><![CDATA[<![CDATA[Text with <xml-like> LaTeX]]></latex_document>',
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
