// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

import { cleanSessionDescription } from '@agent/runtime/sessionDescription';

describe('cleanSessionDescription', () => {
  it.each<[name: string, input: string, expected: string]>([
    [
      'returns short text unchanged',
      'Reviewing introduction for clarity',
      'Reviewing introduction for clarity',
    ],
    [
      'collapses newlines into single spaces',
      'Reviewing\nintroduction\n  for clarity',
      'Reviewing introduction for clarity',
    ],
    [
      'strips surrounding double quotes',
      '"Fixing TikZ arrows"',
      'Fixing TikZ arrows',
    ],
    [
      'strips surrounding backticks',
      '`Fixing TikZ arrows`',
      'Fixing TikZ arrows',
    ],
    [
      'strips surrounding single quotes',
      "'Fixing TikZ arrows'",
      'Fixing TikZ arrows',
    ],
    ['strips a trailing period', 'Fixing arrows.', 'Fixing arrows'],
    [
      'strips trailing bang and question marks',
      'Fixing arrows!?',
      'Fixing arrows',
    ],
    ['strips a trailing ellipsis', 'Fixing arrows…', 'Fixing arrows'],
    ['empties quote-only input', '"..."', ''],
    ['empties backtick-only input', '``', ''],
    ['empties whitespace-only input', '   ', ''],
    [
      'rejects full-sentence helper responses instead of persisting stale prose',
      'Since the system environment for this run does not provide delegation tools, I cannot delegate.',
      '',
    ],
    [
      'keeps compact labels within the description word budget',
      'Checking concise proof with one delegated review subagent',
      'Checking concise proof with one delegated review subagent',
    ],
  ])('%s', (_name, input, expected) => {
    assert.equal(cleanSessionDescription(input), expected);
  });

  it('truncates with ellipsis at 80 characters', () => {
    const result = cleanSessionDescription('a'.repeat(120));
    assert.equal(result.length, 80);
    assert.ok(result.endsWith('…'));
  });
});
