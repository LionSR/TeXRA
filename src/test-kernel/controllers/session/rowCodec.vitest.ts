import { Result, Schema } from 'effect';
import { expect, it } from 'vitest';

import { decodeRow, encodeDraft } from '@controllers/session/rowCodec';
import { qualifyAggregateId, RunIdSchema } from '@shared/schemas';
import type { PluginArms } from '@tools/plugins';

// Failure modes: a compatibility chain starting after version 1 skips steps,
// a current value is converted twice, or an unsupported version is accepted.
it('reads every supported version from the start of its compatibility chain', () => {
  const arms: PluginArms = {
    'example/count': {
      plugin: 'example',
      kind: 'count',
      version: 4,
      schema: Schema.Int,
      upcasters: [
        (value) => Schema.decodeUnknownSync(Schema.Int)(value) + 10,
        (value) => Schema.decodeUnknownSync(Schema.Int)(value) * 2,
      ],
    },
  };
  const read = (version: number, value: number) =>
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
        origin: '["test",1,"process-1"]',
        at: 0,
      },
      arms,
      new Map(),
    );

  for (const [version, value] of [
    [2, 2],
    [3, 12],
    [4, 24],
  ]) {
    const result = read(version, value);
    expect(Result.getOrThrow(result)).toMatchObject({ version: 4, value: 24 });
  }
  for (const [version, tag] of [
    [1, 'DatabaseRowEarlier'],
    [5, 'DatabaseStoreNewer'],
  ] as const) {
    const result = read(version, 2);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure._tag).toBe(tag);
  }
});
