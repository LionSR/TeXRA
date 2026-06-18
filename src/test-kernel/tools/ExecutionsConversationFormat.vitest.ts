import { describe, expect, it } from 'vitest';

import { formatConversation } from '@tools/executions/conversationFormat';

describe('formatConversation', () => {
  it('preserves ASCII truncation for conversation output', () => {
    const output = formatConversation([
      { role: 'assistant', content: 'x'.repeat(501) },
    ]);

    expect(output).toContain(`${'x'.repeat(497)}...`);
    expect(output).not.toContain('…');
  });
});
