import { z } from 'zod';

import { NonAgentRunRecordSchema } from '@shared/schemas';
import { AgentConfigSchema, type AgentConfig } from './AgentConfig';

/**
 * The canonical run configuration: a real
 * `AgentConfig` for agent runs, the honest minimal record for everything
 * else. The strict non-agent arm parses first — `AgentConfigSchema`'s
 * prefaults would otherwise fabricate an agent config out of any object.
 */
export const RunRecordSchema = z.union([
  NonAgentRunRecordSchema,
  AgentConfigSchema,
]);

export type RunRecord = z.infer<typeof RunRecordSchema>;

/** The key only an agent config carries (`agent` is prefaulted, so every
 *  parsed agent config has it; the strict non-agent arm cannot). Typed so a
 *  rename on either arm fails to compile instead of silently matching none. */
const AGENT_RECORD_KEY: Exclude<
  keyof AgentConfig,
  keyof z.infer<typeof NonAgentRunRecordSchema>
> = 'agent';

/** Whether `record` is an agent run's config. */
export function isAgentRunRecord(record: RunRecord): record is AgentConfig {
  return AGENT_RECORD_KEY in record;
}
