// Node.js built-in imports
import { strict as assert } from 'assert';

// Internal imports
import { stripCriticizeAnnotations } from '@replacement/advanced';

describe('stripCriticizeAnnotations', () => {
  it('removes a whole-line \\criticize and its trailing newline', () => {
    const input = `before\n\\criticize{a}{b}{c}\nafter`;
    const { content, count } = stripCriticizeAnnotations(input);
    assert.strictEqual(content, `before\nafter`);
    assert.strictEqual(count, 1);
  });

  it('removes a whole-line \\criticize with leading indentation', () => {
    const input = `before\n  \\criticize{a}{b}{c}\nafter`;
    const { content, count } = stripCriticizeAnnotations(input);
    assert.strictEqual(content, `before\nafter`);
    assert.strictEqual(count, 1);
  });

  it('preserves trailing text when \\criticize is followed by other content on the same line', () => {
    const input = `\\criticize{a}{b}{c} trailing text`;
    const { content, count } = stripCriticizeAnnotations(input);
    assert.strictEqual(content, ` trailing text`);
    assert.strictEqual(count, 1);
  });

  it('preserves surrounding prose when \\criticize appears inline', () => {
    const input = `This sentence \\criticize{a}{b}{c} continues on.`;
    const { content, count } = stripCriticizeAnnotations(input);
    assert.strictEqual(content, `This sentence  continues on.`);
    assert.strictEqual(count, 1);
  });

  it('handles nested braces inside \\criticize arguments', () => {
    const input = `\\criticize{note with \\textbf{bold}}{high}{0.9}\n`;
    const { content, count } = stripCriticizeAnnotations(input);
    assert.strictEqual(content, ``);
    assert.strictEqual(count, 1);
  });

  it('is a no-op when content has no \\criticize', () => {
    const input = `no annotations here`;
    const { content, count } = stripCriticizeAnnotations(input);
    assert.strictEqual(content, input);
    assert.strictEqual(count, 0);
  });
});
