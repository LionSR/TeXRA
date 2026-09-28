import { z } from 'zod';

/** The most skills a run's catalog keeps per source, and a step lists. */
export const SKILL_CATALOG_MAX_SKILLS = 200;

/** Canonical skill-source scope vocabulary, shared with the skills loader
 *  (`src/skills/loadSkills.ts`) and the persisted disabled-source setting, so
 *  a scope added here is representable everywhere. */
export const ActiveSkillSourceScopeSchema = z.enum([
  'bundled',
  'user',
  'project',
  'interop',
  'custom',
]);

export type ActiveSkillSourceScope = z.infer<
  typeof ActiveSkillSourceScopeSchema
>;
