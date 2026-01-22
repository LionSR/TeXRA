// Standard library imports
import { strict as assert } from 'assert';

/**
 * Tests for the markdown renderer's bold text line break insertion.
 *
 * The regex `/\.\s*(\*\*[A-Z])/g` with replacement `'.\n$1'` ensures that
 * bold text starting a new sentence gets placed on its own line for better
 * markdown rendering.
 */
describe('markdownRenderer bold text line breaks', () => {
  // The regex pattern from processMarkdownContent
  const boldLineBreakRegex = /\.\s*(\*\*[A-Z])/g;
  const applyReplacement = (input: string): string =>
    input.replace(boldLineBreakRegex, '.\n$1');

  describe('should add line break before bold headers', () => {
    it('handles period directly followed by bold text (.**Bold)', () => {
      const input = 'This is a sentence.**Bold Header**';
      const expected = 'This is a sentence.\n**Bold Header**';
      assert.equal(applyReplacement(input), expected);
    });

    it('handles period with space before bold text (. **Bold)', () => {
      const input = 'This is a sentence. **Bold Header**';
      const expected = 'This is a sentence.\n**Bold Header**';
      assert.equal(applyReplacement(input), expected);
    });

    it('handles period with multiple spaces before bold text', () => {
      const input = 'This is a sentence.  **Bold Header**';
      const expected = 'This is a sentence.\n**Bold Header**';
      assert.equal(applyReplacement(input), expected);
    });

    it('handles multiple occurrences in same text', () => {
      const input =
        'First section. **Section Two** content here. **Section Three**';
      const expected =
        'First section.\n**Section Two** content here.\n**Section Three**';
      assert.equal(applyReplacement(input), expected);
    });
  });

  describe('should NOT add line break in these cases', () => {
    it('preserves bold text not starting with capital letter', () => {
      const input = 'This is a sentence. **lower case** text';
      assert.equal(applyReplacement(input), input);
    });

    it('preserves bold text in middle of sentence (no period before)', () => {
      const input = 'This is **Bold Text** in a sentence';
      assert.equal(applyReplacement(input), input);
    });

    it('preserves single asterisk emphasis', () => {
      const input = 'This is a sentence. *Italics* here';
      assert.equal(applyReplacement(input), input);
    });

    it('preserves existing line breaks (already formatted)', () => {
      const input = 'This is a sentence.\n**Already Formatted**';
      // Already has newline, so no change
      assert.equal(applyReplacement(input), input);
    });
  });

  describe('real-world thinking content examples', () => {
    it('handles thinking block header style from Claude', () => {
      const input =
        "diagnose what's wrong and fix them. **Accessing PDF attachments** I'm considering whether";
      const expected =
        "diagnose what's wrong and fix them.\n**Accessing PDF attachments** I'm considering whether";
      assert.equal(applyReplacement(input), expected);
    });

    it('handles OpenAI reasoning summary style', () => {
      const input =
        'The user wants to add a feature.**Analyzing codebase** I need to find the relevant files.**Implementation plan** Here are the steps';
      const expected =
        'The user wants to add a feature.\n**Analyzing codebase** I need to find the relevant files.\n**Implementation plan** Here are the steps';
      assert.equal(applyReplacement(input), expected);
    });
  });
});
