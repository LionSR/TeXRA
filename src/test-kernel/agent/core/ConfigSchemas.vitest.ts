// Standard library imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { describe, it } from 'vitest';
import { z } from 'zod';

// Local imports
import {
  AgentConfigSchema,
  ToolUseAgentConfigSchema,
  WorkflowAgentConfigSchema,
} from '@agent/core/definition/AgentConfig';
import {
  AGENT_SOURCE,
  AgentCategory,
} from '@shared/schemas';
import { ToolConfigSchema } from '@shared/schemas/toolConfig';

describe('ToolConfigSchema', () => {
  it('ignores unknown toolConfig keys', () => {
    const parsed = ToolConfigSchema.parse({
      reflect: true,
      usePrefillFromInput: true,
      printInputPrompt: true,
    } as Record<string, unknown>);

    assert.strictEqual('reflect' in parsed, false);
    assert.strictEqual(parsed.autoExtractFigure, false);
    assert.strictEqual(
      (parsed as Record<string, unknown>).usePrefillFromInput,
      undefined,
    );
    assert.strictEqual(
      (parsed as Record<string, unknown>).printInputPrompt,
      undefined,
    );
  });
});

describe('AgentConfigSchema', () => {
  it('strips unknown properties for backward compatibility', () => {
    const parsed = AgentConfigSchema.parse({
      legacyFlag: 'remove-me',
      toolConfig: {
        reflect: true,
        usePrefillFromInput: true,
      },
    } as Record<string, unknown>);

    assert.ok(parsed.toolConfig, 'toolConfig should be defined when provided');
    assert.strictEqual('reflect' in parsed.toolConfig, false);
    assert.strictEqual(parsed.toolConfig.autoExtractFigure, false);
    assert.strictEqual('legacyFlag' in parsed, false);
    assert.deepStrictEqual(parsed.inputFiles, []);
    assert.strictEqual(
      'usePrefillFromInput' in (parsed.toolConfig as Record<string, unknown>),
      false,
    );
    assert.strictEqual(parsed.agentCategory, AgentCategory.Workflow);
  });

  it('defaults to Workflow category when agentCategory is omitted', () => {
    const parsed = AgentConfigSchema.parse({});

    assert.strictEqual(parsed.agentCategory, AgentCategory.Workflow);
  });

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
 * `agentSource` is persisted (execution `config.json`, trace documents), so
 * widening `AGENT_SOURCE` is a persisted-schema change in both directions.
 */
describe('AgentConfigSchema agentSource compatibility', () => {
  it('round-trips every current source, including inline', () => {
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

  it('makes an older build reject an inline source rather than drop it', () => {
    // Forward compatibility is a downgrade scenario: only a widened build can
    // write `inline`, and an older build validates the same field with the
    // enum as it stood before. `.nullish()` keeps the field optional, but a
    // *present* unknown value is a parse error — so the older build fails at
    // its read boundary rather than silently defaulting the source. Every
    // persisted read is already written for that: `ExecutionKVStore.readConfig`
    // goes through `readValidated`, which warns and returns null (the same
    // "corrupt config" path history views already handle), and
    // `executionListing`'s backfill logs and skips the entry.
    const olderBuildSourceSchema = z
      .enum(['custom', 'builtInWorkflow', 'builtInToolUse', 'remote'])
      .nullish();

    assert.strictEqual(
      olderBuildSourceSchema.safeParse('inline').success,
      false,
    );
    assert.strictEqual(
      olderBuildSourceSchema.safeParse(undefined).success,
      true,
    );
    assert.strictEqual(
      olderBuildSourceSchema.safeParse('custom').success,
      true,
    );
  });
});
