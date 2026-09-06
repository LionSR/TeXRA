/** Existing transcript redaction rules, shared by publication and display. */
import { redactSecrets } from '@logger/redaction';
import {
  ActiveSkillsSnapshotSchema,
  SessionEventDraftSchema,
  type SessionEventDraft,
} from '@shared/schemas';
import { isObject } from '@utils/core';

/** Apply the existing transcript rules before source facts enter the event table. */
export function redactTraceDraft(event: SessionEventDraft): SessionEventDraft {
  switch (event.type) {
    case 'result':
      return SessionEventDraftSchema.parse({
        ...event,
        error: redactLogData(event.error),
      });
    case 'log':
      return {
        ...event,
        message: redactSecrets(event.message),
        data: redactLogData(event.data),
      };
    case 'stage.start':
      return { ...event, label: redactSecrets(event.label) };
    case 'tool.start':
      return {
        ...event,
        input: redactToolInputForLog(event.toolName, event.input),
      };
    case 'tool.end': {
      const result = event.result;
      if (!isObject(result) || typeof result.toolName !== 'string')
        return event;
      return {
        ...event,
        result: {
          ...result,
          input: redactToolInputForLog(result.toolName, result.input),
        },
      };
    }
    case 'workflow.plan':
      return {
        ...event,
        phases: event.phases.map((phase) => ({
          ...phase,
          title: redactSecrets(phase.title),
        })),
        tasks: event.tasks.map((task) => ({
          ...task,
          label: redactSecrets(task.label),
          ...(task.phase !== undefined && { phase: redactSecrets(task.phase) }),
        })),
      };
    case 'workflow.call':
      return {
        ...event,
        call:
          event.call.status === 'failed'
            ? {
                ...event.call,
                label: redactSecrets(event.call.label),
                error: redactSecrets(event.call.error),
              }
            : { ...event.call, label: redactSecrets(event.call.label) },
      };
    case 'skills.snapshot':
      return {
        ...event,
        skills: ActiveSkillsSnapshotSchema.parse(event).skills,
      };
    case 'stream.end':
      return {
        ...event,
        ...(event.finalText !== undefined && {
          finalText: redactSecrets(event.finalText),
        }),
      };
    case 'response.finalized':
      return { ...event, text: redactSecrets(event.text) };
    case 'domain':
      return {
        ...event,
        ...(event.text !== undefined && { text: redactSecrets(event.text) }),
        data: redactLogData(event.data),
      };
    default:
      return event;
  }
}

/**
 * Redact secrets from a tool's recorded input before it is persisted.
 * Older sessions may replay `set_api_key` events whose tool.start/tool.end
 * payload carries the raw input. The tool is no longer registered, but this
 * redaction remains so imported or resumed history cannot write a legacy key
 * into the current transcript. New secret-bearing tool inputs must extend this
 * guard.
 */
export function redactToolInputForLog(
  toolName: string,
  input: unknown,
): unknown {
  if (
    toolName !== 'set_api_key' ||
    input === null ||
    typeof input !== 'object' ||
    !('key' in input)
  ) {
    return input;
  }
  return { ...input, key: '[redacted]' };
}

/**
 * An error row keeps its provider detail in `data.message` (ErrorLogData), and
 * every host renders that field next to the row text, so it needs the same
 * record-time redaction: a provider error body can echo the request URL or an
 * `Authorization` header.
 *
 * Only a plain payload is rebuilt. A caller may pass a raw `Error` as log data,
 * whose `message` and `stack` are non-enumerable own properties that a spread
 * would silently drop; such an object serializes to `{}` on the wire and on
 * disk anyway, so it is left untouched.
 */
export function redactLogData(data: unknown): unknown {
  if (
    !isObject(data) ||
    Object.getPrototypeOf(data) !== Object.prototype ||
    typeof data.message !== 'string'
  ) {
    return data;
  }
  // Every string the hosts render beside an error row: rawMessage and
  // rawErrorBody carry provider error bodies (which can echo request URLs or
  // Authorization headers), statusText is the provider's HTTP status line,
  // partialText carries truncated model output.
  const redacted: Record<string, unknown> = { ...data };
  for (const key of [
    'message',
    'rawMessage',
    'rawErrorBody',
    'statusText',
    'partialText',
  ]) {
    if (typeof redacted[key] === 'string') {
      redacted[key] = redactSecrets(redacted[key] as string);
    }
  }
  return redacted;
}
