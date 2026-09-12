// Standard library imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { describe, it } from 'vitest';

// Local imports
import {
  AgentConfigSchema,
  ToolUseAgentConfigSchema,
  WorkflowAgentConfigSchema,
} from '@agent/core/definition/AgentConfig';
import { AGENT_SOURCE, AgentCategory, ToolConfigSchema } from '@shared/schemas';

describe('AgentConfigSchema', () => {
  it('keeps category-specific parsers aligned with the discriminated union', () => {
    const workflow = WorkflowAgentConfigSchema.parse({});
    const toolUse = ToolUseAgentConfigSchema.parse({
      agentCategory: AgentCategory.ToolUse,
    });

    assert.strictEqual(workflow.agentCategory, AgentCategory.Workflow);
    assert.strictEqual(toolUse.agentCategory, AgentCategory.ToolUse);
    assert.throws(() => ToolUseAgentConfigSchema.parse(workflow));
    assert.throws(() => WorkflowAgentConfigSchema.parse(toolUse));
  });

  it('applies shared output-file validation to category-specific parsers', () => {
    assert.throws(() =>
      ToolUseAgentConfigSchema.parse({
        agentCategory: AgentCategory.ToolUse,
        outputFiles: ['result.tex'],
      }),
    );
  });
});

/**
 * `agentSource` is persisted (run `config.json`, trace documents), so
 * widening `AGENT_SOURCE` is a persisted-schema change in both directions.
 */
describe('AgentConfigSchema agentSource compatibility', () => {
  it('round-trips every current source', () => {
    for (const source of Object.values(AGENT_SOURCE)) {
      const parsed = AgentConfigSchema.parse({
        agent: 'scratchpad',
        agentSource: source,
      });
      assert.strictEqual(parsed.agentSource, source);
    }
  });

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
