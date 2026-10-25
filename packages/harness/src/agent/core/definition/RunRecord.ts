import type {
  NonAgentRunRecordSchema,
  RunRecordFieldsSchema,
} from '@shared/schemas';

import type { AgentConfig } from './AgentConfig';

/**
 * The canonical run configuration (`RunRecordFieldsSchema`, the `run.config`
 * row's field): a real `AgentConfig` for agent runs, the honest minimal
 * record for everything else. The union keeps the strict non-agent arm
 * first: the agent arm's prefaults would fabricate an agent config out of
 * any object.
 */
export type RunRecord = typeof RunRecordFieldsSchema.Type;

/** The key only an agent config carries (`agent` is prefaulted, so every
 *  parsed agent config has it; the strict non-agent arm cannot). Typed so a
 *  rename on either arm fails to compile instead of silently matching none. */
const AGENT_RECORD_KEY: Exclude<
  keyof AgentConfig,
  keyof typeof NonAgentRunRecordSchema.Type
> = 'agent';

/** Whether `record` is an agent run's config. */
export function isAgentRunRecord(record: RunRecord): record is AgentConfig {
  return AGENT_RECORD_KEY in record;
}

/** Whether the run's script is trusted: the app wrote it (a plugin's
 *  recipe, by `script.kind`), not a model. Its tools are fixed past any
 *  switch; the agents it calls are the catalog's, under its launch's
 *  approval, and take its prompts and files as written; it activates no
 *  skills. */
export const isTrustedScript = (config: Pick<AgentConfig, 'script'>): boolean =>
  config.script?.kind === 'recipe';
