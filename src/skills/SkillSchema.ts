// Third-party imports
import { z } from 'zod';

// Local imports - utilities
import { collapseWhitespace } from '@utils/text/stringUtils';

export const SKILL_NAME_MAX_LENGTH = 64;
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;

export const SkillNameSchema = z
  .string()
  .transform((name) => collapseWhitespace(name))
  .refine((name) => name.length > 0, 'Skill name is required')
  .refine(
    (name) => name.length <= SKILL_NAME_MAX_LENGTH,
    `Skill name must be at most ${SKILL_NAME_MAX_LENGTH} characters`,
  )
  .refine(
    (name) => /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(name),
    'Skill name must contain only lowercase letters, digits, and hyphens',
  )
  .refine(
    (name) => !name.includes('--'),
    'Skill name must not contain repeated hyphens',
  );

export const SkillDescriptionSchema = z
  .string()
  .transform((description) => collapseWhitespace(description))
  .refine((description) => description.length > 0, {
    message: 'Skill description is required',
  })
  .refine(
    (description) => description.length <= SKILL_DESCRIPTION_MAX_LENGTH,
    `Skill description must be at most ${SKILL_DESCRIPTION_MAX_LENGTH} characters`,
  );

export const SkillFrontmatterSchema = z.looseObject({
  name: SkillNameSchema,
  description: SkillDescriptionSchema,
});

export const SkillSchema = z.strictObject({
  name: SkillNameSchema,
  description: SkillDescriptionSchema,
  body: z.string().min(1),
  baseDir: z.string().min(1),
  path: z.string().min(1),
  frontmatter: SkillFrontmatterSchema,
});

export type Skill = z.infer<typeof SkillSchema>;
export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;
