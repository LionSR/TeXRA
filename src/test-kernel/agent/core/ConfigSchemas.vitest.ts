import { strict as assert } from 'node:assert';

import { describe, it } from 'vitest';

import { Result, Schema, SchemaIssue } from 'effect';
import { AgentConfigSchema } from '@shared/schemas';

/**
 * `agentSource` is persisted (run `config.json`, trace documents), so
 * widening or narrowing `AGENT_SOURCE` is a persisted-schema change.
 */
describe('AgentConfigSchema agentSource compatibility', () => {
  it('reads records persisted before the field existed', () => {
    assert.strictEqual(
      Schema.decodeUnknownSync(AgentConfigSchema)({}).agentSource,
      undefined,
    );
    assert.strictEqual(
      Schema.decodeUnknownSync(AgentConfigSchema)({ agentSource: null })
        .agentSource,
      null,
    );
  });

  it('rejects an unrecognized source loudly instead of defaulting it', () => {
    const result = Schema.decodeUnknownResult(AgentConfigSchema)({
      agentSource: 'notASource',
    });

    assert.strictEqual(Result.isFailure(result), true);
    if (!Result.isFailure(result)) return;
    const [issue] = SchemaIssue.makeFormatterStandardSchemaV1()(
      result.failure.issue,
    ).issues;
    assert.deepStrictEqual(issue?.path, ['agentSource']);
  });
});
