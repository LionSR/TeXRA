import { Schema } from 'effect';

/** The most skills a run's catalog keeps per source, and a step lists. */
export const SKILL_CATALOG_MAX_SKILLS = 200;

/** The most skills a run keeps activated; a newer activation displaces the
 *  oldest. */
export const ACTIVATED_SKILLS_MAX = 20;

/** Canonical skill-source scope vocabulary, shared with the skills loader
 *  and the persisted disabled-source setting, so
 *  a scope added here is representable everywhere. */
export const ActiveSkillSourceScopeSchema = Schema.Literals([
  'bundled',
  'user',
  'project',
  'interop',
  'custom',
]);

/**
 * The decoded shape of {@link ActiveSkillSourceScopeSchema}: where a skill was
 * found.
 */
export type ActiveSkillSourceScope =
  (typeof ActiveSkillSourceScopeSchema)['Type'];
