// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Node.js built-in imports

// Internal imports
import { stripCriticizeAnnotations } from '@replacement/advanced';

describe('stripCriticizeAnnotations', () => {
  it.each([
    {
      name: 'removes a whole-line \\criticize and its trailing newline',
      input: `before\n\\criticize{a}{b}{c}\nafter`,
      content: `before\nafter`,
      count: 1,
    },
    {
      name: 'removes a whole-line \\criticize with leading indentation',
      input: `before\n  \\criticize{a}{b}{c}\nafter`,
      content: `before\nafter`,
      count: 1,
    },
    {
      name: 'preserves trailing text when \\criticize is followed by other content on the same line',
      input: `\\criticize{a}{b}{c} trailing text`,
      content: ` trailing text`,
      count: 1,
    },
    {
      name: 'preserves surrounding prose when \\criticize appears inline',
      input: `This sentence \\criticize{a}{b}{c} continues on.`,
      content: `This sentence  continues on.`,
      count: 1,
    },
    {
      name: 'handles nested braces inside \\criticize arguments',
      input: `\\criticize{note with \\textbf{bold}}{high}{0.9}\n`,
      content: ``,
      count: 1,
    },
    {
      name: 'is a no-op when content has no \\criticize',
      input: `no annotations here`,
      content: `no annotations here`,
      count: 0,
    },
  ])('$name', ({ input, content, count }) => {
    const result = stripCriticizeAnnotations(input);
    assert.strictEqual(result.content, content);
    assert.strictEqual(result.count, count);
  });
});
