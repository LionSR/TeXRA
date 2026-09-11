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
  // The pre-collapse two-channel envelope is no longer merged: `input` and
  // `transient` parse as two ordinary custom variables whose record values
  // fail the fixed-key schema.
  it('rejects a retired two-channel record instead of merging it', () => {
    assert.throws(
      () =>
        UserVariableChannelsSchema.parse({
          input: { MODEL: 'gpt54', IS_OPENAI_MODEL: true },
          transient: { MODEL: 'gpt55', CUSTOM_FILE: 'notes.md' },
        }),
      z.ZodError,
    );
  });
});
