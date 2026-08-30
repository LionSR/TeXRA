import { z } from 'zod';

import { ActiveSkillSourceScopeSchema } from './activeSkills';
import { SkillNameSchema } from './skillName';

/** One discovered skill projected for host settings displays. */
export const SkillDisplayItemSchema = z.strictObject({
  name: SkillNameSchema,
  description: z.string(),
  scope: ActiveSkillSourceScopeSchema,
  label: z.string(),
  path: z.string(),
  enabled: z.boolean(),
});

export type SkillDisplayItem = z.infer<typeof SkillDisplayItemSchema>;

/** Discovery problem safe to carry to settings UIs. */
export const SkillDisplayIssueSchema = z.strictObject({
  message: z.string(),
  path: z.string().optional(),
});

export type SkillDisplayIssue = z.infer<typeof SkillDisplayIssueSchema>;
