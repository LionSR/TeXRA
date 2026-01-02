// Standard library imports
import { strict as assert } from 'assert';

// Local imports - agent core
import { AgentConfigSchema } from '@agent/core/AgentConfig';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { ToolConfigSchema } from '@agent/core/ToolConfig';

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
    assert.strictEqual(parsed.session?.agentCategory, AgentCategory.Workflow);
  });

  it('derives workflow metadata when session is omitted', () => {
    const parsed = AgentConfigSchema.parse({});

    assert.ok(parsed.session);
    assert.strictEqual(parsed.session?.agentCategory, AgentCategory.Workflow);
  });
});
