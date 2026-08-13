// Third-party imports
import { z } from 'zod';

// Local imports - shared schemas and utilities
import { SkillNameSchema } from '@shared/schemas';
import { collapseWhitespace } from '@utils/text/stringUtils';

export { SkillNameSchema } from '@shared/schemas';

export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;

const SkillDescriptionSchema = z
  .string()
  .transform((description) => collapseWhitespace(description))
  .refine(
    (description) => description.length > 0,
    'Skill description is required',
  )
  .refine(
    (description) => description.length <= SKILL_DESCRIPTION_MAX_LENGTH,
    `Skill description must be at most ${SKILL_DESCRIPTION_MAX_LENGTH} characters`,
  );

export const SkillSchema = z.strictObject({
  name: SkillNameSchema,
  description: SkillDescriptionSchema,
  body: z.string().min(1),
  baseDir: z.string().min(1),
  path: z.string().min(1),
});

export type Skill = z.infer<typeof SkillSchema>;
