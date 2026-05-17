// Standard library imports
import { strict as assert } from 'assert';

// Local imports - agent core

import { AgentConfigSchema } from '@agent/core/AgentConfig';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { MainViewPersistedStateSchema } from '@shared/schemas/mainView';
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

  it('migrates legacy single file slots into canonical file lists', () => {
    const parsed = AgentConfigSchema.parse({
      inputFile: 'main.tex',
      inputFiles: ['chapter.tex'],
      contextFile: 'refs.bib',
      mediaFile: 'figure.png',
    });

    assert.deepStrictEqual(parsed.inputFiles, ['main.tex', 'chapter.tex']);
    assert.deepStrictEqual(parsed.contextFiles, ['refs.bib']);
    assert.deepStrictEqual(parsed.mediaFiles, ['figure.png']);
  });

  it('migrates legacy main-view file slots into canonical file lists', () => {
    const parsed = MainViewPersistedStateSchema.parse({
      inputFile: 'main.tex',
      referenceFile: 'refs.bib',
      mediaFile: 'figure.png',
    });

    assert.deepStrictEqual(parsed.inputFiles, ['main.tex']);
    assert.deepStrictEqual(parsed.contextFiles, ['refs.bib']);
    assert.deepStrictEqual(parsed.mediaFiles, ['figure.png']);
  });
});
