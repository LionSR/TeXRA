import type { AgentTrace } from '@agent/trace';
import type {
  AddOutputFilesPayload,
  GoalPausedPayload,
  UpdateCompileFailuresPayload,
  UpdateMissingOutputsPayload,
  UpdatePlanPayload,
  UpdateTodosPayload,
} from '@shared/schemas';

/**
 * Run facts ride the run trace as `domain` events keyed `'runFact.' + name`.
 * The prefix survives until v0.41: every key still has live consumers of the
 * prefixed key (R8 census 2026-07-07 — the CLI projection decodes all six,
 * `StreamSnapshotStore` persists all but `goalPaused`, the CLI TUI applies
 * `updateTodos`/`updatePlan`/`goalPaused`, the extension filters on
 * `addOutputFiles`). Retiring it means typed `AgentEvent` arms per fact.
 */
export const RUN_FACT_DOMAIN_PREFIX = 'runFact.';

export type RunFactPayloads = {
  updateTodos: UpdateTodosPayload;
  updatePlan: UpdatePlanPayload;
  addOutputFiles: AddOutputFilesPayload;
  updateMissingOutputs: UpdateMissingOutputsPayload;
  updateCompileFailures: UpdateCompileFailuresPayload;
  goalPaused: GoalPausedPayload;
};

export type RunFactEventName = keyof RunFactPayloads;

// `satisfies Record<...>` (not a name array) so a new `RunFactPayloads` key
// fails compile here until it is decodable, instead of silently dropping.
const RUN_FACT_EVENT_NAMES = {
  updateTodos: true,
  updatePlan: true,
  addOutputFiles: true,
  updateMissingOutputs: true,
  updateCompileFailures: true,
  goalPaused: true,
} as const satisfies Record<RunFactEventName, true>;

const RUN_FACT_EVENT_SET = new Set<string>(Object.keys(RUN_FACT_EVENT_NAMES));

export function toRunFactDomainKey(event: RunFactEventName): string {
  return `${RUN_FACT_DOMAIN_PREFIX}${event}`;
}

export function fromRunFactDomainKey(
  key: string,
): RunFactEventName | undefined {
  if (!key.startsWith(RUN_FACT_DOMAIN_PREFIX)) return undefined;
  const event = key.slice(RUN_FACT_DOMAIN_PREFIX.length);
  return RUN_FACT_EVENT_SET.has(event)
    ? (event as RunFactEventName)
    : undefined;
}

export function emitRunFact<K extends RunFactEventName>(
  trace: AgentTrace,
  event: K,
  payload: RunFactPayloads[K],
): void {
  trace.domain({
    key: toRunFactDomainKey(event),
    data: payload,
  });
}
