// Third-party imports
import { Schema } from 'effect';

// Local imports - shared schemas
import { QualifiedSkillNameSchema } from '@shared/schemas';

export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;

export const SkillSchema = Schema.Struct({
  name: QualifiedSkillNameSchema,
  /** Collapsed, non-empty and at most {@link SKILL_DESCRIPTION_MAX_LENGTH}
   *  characters before it gets here: `skillLoader.normalizeSkillDescription`
   *  owns that policy and reports what it changed. */
  description: Schema.String,
  body: Schema.String.check(Schema.isMinLength(1)),
  baseDir: Schema.String.check(Schema.isMinLength(1)),
  path: Schema.String.check(Schema.isMinLength(1)),
});

export type Skill = typeof SkillSchema.Type;
