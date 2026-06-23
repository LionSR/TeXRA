import { describe, expect, it } from 'vitest';

import {
  AgentCategory,
  AgentDefinitionSchema,
  AgentSettingSchema,
} from '@agent/core/definition/AgentDataclass';

describe('AgentSettingSchema', () => {
  it('strips legacy workflow outputExt without exposing it in settings', () => {
    const setting = AgentSettingSchema.parse({
      agentCategory: AgentCategory.Workflow,
      outputExt: 'tex',
    });

    expect(setting.agentCategory).toBe(AgentCategory.Workflow);
    expect(Object.hasOwn(setting, 'outputExt')).toBe(false);
  });

  it('trims documentTag before deriving endTag', () => {
    const setting = AgentSettingSchema.parse({
      agentCategory: AgentCategory.Workflow,
      documentTag: '  latex_document  ',
    });

    expect(setting.documentTag).toBe('latex_document');
    expect(setting.endTag).toBe('</latex_document>');
  });

  it('rejects blank documentTag values', () => {
    expect(() =>
      AgentSettingSchema.parse({
        agentCategory: AgentCategory.Workflow,
        documentTag: '   ',
      }),
    ).toThrow('documentTag cannot be empty');
  });
});

describe('AgentDefinitionSchema', () => {
  it('rejects displayName metadata', () => {
    expect(() =>
      AgentDefinitionSchema.parse({
        name: 'assistant',
        displayName: 'Assistant',
      }),
    ).toThrow();
  });
});
