import { Schema } from 'effect';

import { ActiveSkillSourceScopeSchema } from './activeSkills';
import { QualifiedSkillNameSchema } from './skillName';

/** One discovered skill projected for host settings displays. */
export const SkillDisplayItemSchema = Schema.Struct({
  name: QualifiedSkillNameSchema,
  description: Schema.String,
  scope: ActiveSkillSourceScopeSchema,
  label: Schema.String,
  path: Schema.String,
  /** The directory the skill was discovered under, i.e. its source's path. */
  sourcePath: Schema.String,
  enabled: Schema.Boolean,
});

export type SkillDisplayItem = typeof SkillDisplayItemSchema.Type;

/** Discovery problem safe to carry to settings UIs. */
export const SkillDisplayIssueSchema = Schema.Struct({
  message: Schema.String,
  path: Schema.optional(Schema.String),
});

export type SkillDisplayIssue = typeof SkillDisplayIssueSchema.Type;
