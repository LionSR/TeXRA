import { strict as assert } from 'node:assert';

import { describe, it } from 'vitest';

import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';

/**
 * `agentSource` is persisted (run `config.json`, trace documents), so
 * widening or narrowing `AGENT_SOURCE` is a persisted-schema change.
 */
describe('AgentConfigSchema agentSource compatibility', () => {
  it('reads records persisted before the field existed', () => {
    assert.strictEqual(AgentConfigSchema.parse({}).agentSource, undefined);
    assert.strictEqual(
      AgentConfigSchema.parse({ agentSource: null }).agentSource,
      null,
    );
  });

  it('rejects an unrecognized source loudly instead of defaulting it', () => {
    const result = AgentConfigSchema.safeParse({ agentSource: 'notASource' });

    assert.strictEqual(result.success, false);
    assert.deepStrictEqual(result.error?.issues[0]?.path, ['agentSource']);
  });
});
