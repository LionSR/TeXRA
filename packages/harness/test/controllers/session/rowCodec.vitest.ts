import { Result, Schema } from 'effect';
import { expect, it } from 'vitest';

import {
  factName,
  qualifyAggregateId,
  RunIdSchema,
} from '@texra-ai/harness/schemas';
import { decodeRow, encodeDraft } from '@controllers/session/rowCodec';
import type { FactKinds } from '@tools/plugins';

/** A stored `example/count` fact of `version`, read over `factKinds`. */
const read = (factKinds: FactKinds, version: number, value: number) =>
  decodeRow(
    {
      ...encodeDraft(
        {
          type: 'plugin.fact',
          aggregateId: qualifyAggregateId('run', RunIdSchema.make('aa0001')),
          plugin: 'example',
          kind: 'count',
          version,
          value,
          parent: null,
        },
        [],
      ),
      commit: 1,
      kind: 'run',
      logicalId: 'aa0001',
      seq: 1,
      at: 0,
    },
    factKinds,
    new Map(),
  );

// Failure modes: a fact at a lower or a higher version than its kind's is
// read as the kind's, or one at the kind's version is refused.
it("reads a fact at its kind's version and refuses any other", () => {
  const factKinds: FactKinds = {
    [factName({ plugin: 'example', kind: 'count' })]: {
      plugin: 'example',
      kind: 'count',
      version: 4,
      schema: Schema.Int,
      fork: 'drop',
    },
  };
  expect(Result.getOrThrow(read(factKinds, 4, 24))).toMatchObject({
    version: 4,
    value: 24,
  });
  for (const [version, tag] of [
    [3, 'DatabaseRowEarlier'],
    [5, 'DatabaseStoreNewer'],
  ] as const) {
    const result = read(factKinds, version, 2);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure._tag).toBe(tag);
  }
});

// Failure modes: a fact whose plugin is absent is dropped from the read, or
// read as interpreted (checked, or with no reason it is not).
it('reads a fact of an absent plugin as written, saying why', () => {
  expect(Result.getOrThrow(read({}, 3, 7))).toMatchObject({
    type: 'plugin.fact',
    plugin: 'example',
    kind: 'count',
    version: 3,
    value: 7,
    unavailable: expect.stringContaining('Plugin "example" is unavailable'),
  });
});
