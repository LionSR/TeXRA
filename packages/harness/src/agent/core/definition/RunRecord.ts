import type {
  AgentConfig,
  NonAgentRunRecordSchema,
  RunRecordFieldsSchema,
} from '@shared/schemas';

/**
 * The canonical run configuration (`RunRecordFieldsSchema`, the `run.config`
 * row's field): a real `AgentConfig` for agent runs, the honest minimal
 * record for everything else. The union keeps the strict non-agent arm
 * first: the agent arm's decoding defaults would fabricate an agent config
 * out of any object.
 */
export type RunRecord = typeof RunRecordFieldsSchema.Type;

/** The key only an agent config carries (`agent` has a decoding default, so
 *  every parsed agent config has it; the strict non-agent arm cannot). Typed
 *  so a rename on either arm fails to compile instead of silently matching
 *  none. */
const AGENT_RECORD_KEY: Exclude<
  keyof AgentConfig,
  keyof typeof NonAgentRunRecordSchema.Type
> = 'agent';

/** Whether `record` is an agent run's config. */
export function isAgentRunRecord(record: RunRecord): record is AgentConfig {
  return AGENT_RECORD_KEY in record;
}
