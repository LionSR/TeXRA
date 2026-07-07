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
 * The prefix survives this stage because every key below still has live
 * direct consumers (extension run-fact subscriptions, CLI TUI, snapshot
 * store) plus the retained CLI projection; retiring it means typed
 * `AgentEvent` arms per fact, tracked for a later slice.
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

const RUN_FACT_EVENT_SET = new Set<string>([
  'updateTodos',
  'updatePlan',
  'addOutputFiles',
  'updateMissingOutputs',
  'updateCompileFailures',
  'goalPaused',
] satisfies RunFactEventName[]);

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
