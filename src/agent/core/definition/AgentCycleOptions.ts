import { UserVariableChannelsSchema, type UserVars } from '@shared/schemas';

/**
 * The template-variable map accepted at the render boundary (PromptBuilder,
 * the user-variable channels). Fixed variables may be absent — template
 * rendering keeps `throwOnUndefined` off, so templates must tolerate absence
 * — and agent-defined `requiredFilesInternal` variables add custom keys
 * beside the fixed ones.
 */
export type TemplateVars = Partial<UserVars> & Record<string, unknown>;

/**
 * `buildUserVars`' product: the complete fixed {@link UserVars} vocabulary
 * plus the agent-defined `requiredFilesInternal` `X_FILE`/`X_CONTENT` string
 * pairs beside it. TypeScript has no index signature that excludes the fixed
 * keys, so the custom keys are admitted as unknown — the same view
 * {@link TemplateVars} gives render-boundary readers.
 */
export type BuiltUserVars = UserVars & Record<string, unknown>;

/**
 * The fixed vocabulary as a frozen runtime list, derived from the channel
 * schema (`@shared/schemas`) so a new fixed variable only has to be declared
 * once. Order is irrelevant, both consumers build a map or a set from it.
 */
export const USER_VAR_RUNTIME_TOKENS: ReadonlyArray<keyof UserVars> =
  Object.freeze(
    Object.keys(UserVariableChannelsSchema.shape) as (keyof UserVars)[],
  );
