// Standard library imports
import { strict as assert } from 'assert';

// Local imports - agent core
import { ToolConfigSchema } from '@shared/schemas/toolConfig';

import { AgentConfigSchema } from '@agent/core/AgentConfig';
import { AgentCategory } from '@agent/core/AgentDataclass';

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
    assert.strictEqual(parsed.inputFile, '');
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

  it('migrates legacy session.agentCategory to top level (Workflow)', () => {
    const parsed = AgentConfigSchema.parse({
      agent: 'correct',
      model: 'gemini3p',
      session: { agentCategory: 'workflow' },
    });

    assert.strictEqual(parsed.agentCategory, AgentCategory.Workflow);
    assert.strictEqual(parsed.agent, 'correct');
  });

  it('migrates legacy session.agentCategory to top level (ToolUse)', () => {
    const parsed = AgentConfigSchema.parse({
      agent: 'search',
      model: 'claude',
      session: { agentCategory: 'toolUse' },
    });

    assert.strictEqual(parsed.agentCategory, AgentCategory.ToolUse);
    assert.strictEqual(parsed.agent, 'search');
  });

  it('prefers top-level agentCategory over legacy session.agentCategory', () => {
    const parsed = AgentConfigSchema.parse({
      agentCategory: 'toolUse',
      session: { agentCategory: 'workflow' },
    });

    assert.strictEqual(parsed.agentCategory, AgentCategory.ToolUse);
  });
});
