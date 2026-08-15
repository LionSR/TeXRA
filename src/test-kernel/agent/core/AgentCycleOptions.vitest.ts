// Standard library imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { describe, it } from 'vitest';
import { z } from 'zod';

// Local imports
import { UserVariableChannelsSchema } from '@agent/core/definition/AgentCycleOptions';

describe('UserVariableChannelsSchema', () => {
  it('validates known fixed keys while preserving custom keys', () => {
    const parsed = UserVariableChannelsSchema.parse({
      input: Object.freeze({
        MODEL: 'gpt54',
        IS_OPENAI_MODEL: true,
        INPUT_FILES: ['paper.tex'],
        MEDIA_CONTENT: null,
      }),
      transient: {
        MODEL: 'gpt55',
        CUSTOM_FILE: 'notes.md',
      },
    });

    assert.strictEqual(parsed.input.MODEL, 'gpt54');
    assert.strictEqual(parsed.input.IS_OPENAI_MODEL, true);
    assert.strictEqual(parsed.transient.MODEL, 'gpt55');
    assert.strictEqual(parsed.transient.CUSTOM_FILE, 'notes.md');
  });

  it('rejects a malformed value for a known fixed key', () => {
    assert.throws(
      () =>
        UserVariableChannelsSchema.parse({
          input: {},
          transient: { MODEL: 42 },
        }),
      z.ZodError,
    );
  });

  it('rejects a malformed value nested in a known fixed key', () => {
    assert.throws(
      () =>
        UserVariableChannelsSchema.parse({
          input: {},
          transient: { ATTACHED_MEMORY_MISSES: [{ path: 42 }] },
        }),
      z.ZodError,
    );
  });
});
