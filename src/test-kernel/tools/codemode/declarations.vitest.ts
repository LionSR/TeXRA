// Failure mode: a tool input whose JSON Schema carries `allOf` beside its own
// `properties` (an Effect `StructWithRest` branch renders that way) lost every
// declared field in the script tool's declaration, so the model saw
// `{ [key: string]: unknown }` instead of the commands it can call.

// Third-party imports
import { describe, expect, it } from 'vitest';
import { Schema } from 'effect';

// Local imports - tools
import { declarationOf } from '@tools/codemode/declarations';

describe('declarationOf', () => {
  it('keeps an object branch’s own fields beside its allOf parts', () => {
    const branch = (command: string) =>
      Schema.StructWithRest(
        Schema.Struct({
          command: Schema.Literal(command),
          path: Schema.String,
        }),
        [Schema.Record(Schema.String, Schema.Unknown)],
      );
    const declaration = declarationOf(
      {
        name: 'diag',
        description: 'Diagnostics.',
        schema: Schema.Union([branch('list'), branch('count')]),
      },
      false,
    );
    expect(declaration).toContain('command: "list"; path: string');
    expect(declaration).toContain('command: "count"; path: string');
  });
});
