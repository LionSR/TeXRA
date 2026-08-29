// Standard library imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

// Local imports
import {
  UserVariableChannelsSchema,
  type BuiltUserVars,
  type TemplateVars,
  type UserVariableChannels,
} from '@agent/core/definition/AgentCycleOptions';

describe('UserVariableChannelsSchema', () => {
  it('validates known fixed keys while preserving custom keys', () => {
    const parsed = UserVariableChannelsSchema.parse({
      MODEL: 'gpt54',
      IS_OPENAI_MODEL: true,
      INPUT_FILES: ['paper.tex'],
      CUSTOM_FILE: 'notes.md',
    });

    assert.strictEqual(parsed.MODEL, 'gpt54');
    assert.strictEqual(parsed.IS_OPENAI_MODEL, true);
    assert.strictEqual(parsed.CUSTOM_FILE, 'notes.md');
  });

  it('merges a legacy two-channel record, newer transient values winning', () => {
    const parsed = UserVariableChannelsSchema.parse({
      input: { MODEL: 'gpt54', IS_OPENAI_MODEL: true },
      transient: { MODEL: 'gpt55', CUSTOM_FILE: 'notes.md' },
    });

    assert.strictEqual(parsed.MODEL, 'gpt55');
    assert.strictEqual(parsed.IS_OPENAI_MODEL, true);
    assert.strictEqual(parsed.CUSTOM_FILE, 'notes.md');
  });

  it('rejects a malformed value for a known fixed key', () => {
    assert.throws(
      () => UserVariableChannelsSchema.parse({ MODEL: 42 }),
      z.ZodError,
    );
  });

  it('rejects a malformed value nested in a known fixed key', () => {
    assert.throws(
      () =>
        UserVariableChannelsSchema.parse({
          ATTACHED_MEMORY_MISSES: [{ path: 42 }],
        }),
      z.ZodError,
    );
  });

  it('accepts the buildUserVars product at the channel boundary', () => {
    expectTypeOf<BuiltUserVars>().toMatchTypeOf<TemplateVars>();
    expectTypeOf<BuiltUserVars>().toMatchTypeOf<UserVariableChannels>();
  });
});
