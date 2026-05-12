import { describe, expect, it } from 'vitest';

import { AgentCategory, AgentSettingSchema } from '@agent/core/AgentDataclass';

describe('AgentSettingSchema', () => {
  it('strips legacy workflow outputExt without exposing it in settings', () => {
    const setting = AgentSettingSchema.parse({
      agentCategory: AgentCategory.Workflow,
      outputExt: 'tex',
    });

    expect(setting.agentCategory).toBe(AgentCategory.Workflow);
    expect(Object.hasOwn(setting, 'outputExt')).toBe(false);
  });
});
