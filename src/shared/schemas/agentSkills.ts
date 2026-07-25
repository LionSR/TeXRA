import { z } from 'zod';

export const AGENT_SKILLS_CONFIG_KEY = 'texra.skills.enabled';
export const AGENT_SKILLS_ENABLED_DEFAULT = true;

/** Whether tool-use agents receive the available TeXRA and imported skills. */
export const AgentSkillsEnabledSchema = z
  .boolean()
  .describe(
    'Discover TeXRA and imported skills and expose them to tool-use agent prompts',
  );

/** Canonical persisted form; absence has the documented enabled default. */
export const AgentSkillsSettingsSchema = z.strictObject({
  enabled: AgentSkillsEnabledSchema.prefault(AGENT_SKILLS_ENABLED_DEFAULT),
});
