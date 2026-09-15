// Third-party imports
import { z } from 'zod';

// Local imports - shared schemas
import { SkillNameSchema } from '@shared/schemas';

export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;

export const SkillSchema = z.strictObject({
  name: SkillNameSchema,
  /** Collapsed, non-empty and at most {@link SKILL_DESCRIPTION_MAX_LENGTH}
   *  characters before it gets here: `skillLoader.normalizeSkillDescription`
   *  owns that policy and reports what it changed. */
  description: z.string(),
  body: z.string().min(1),
  baseDir: z.string().min(1),
  path: z.string().min(1),
});

export type Skill = z.infer<typeof SkillSchema>;
