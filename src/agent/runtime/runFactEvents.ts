import type { AgentTrace } from '@agent/trace';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventContract';

export const RUN_FACT_DOMAIN_PREFIX = 'runFact.';

export const RUN_FACT_EVENT_NAMES = [
  'updateTodos',
  'updatePlan',
  'addOutputFiles',
  'updateMissingOutputs',
  'updateCompileFailures',
  'goalPaused',
] as const satisfies readonly (keyof ProgressEventPayloads)[];

export type RunFactEventName = (typeof RUN_FACT_EVENT_NAMES)[number];

const RUN_FACT_EVENT_SET = new Set<string>(RUN_FACT_EVENT_NAMES);

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
  payload: ProgressEventPayloads[K],
): void {
  trace.domain({
    key: toRunFactDomainKey(event),
    data: payload,
  });
}
