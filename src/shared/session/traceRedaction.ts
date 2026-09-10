/** Existing transcript redaction rules, shared by publication and display. */
import { redactDisplayValue, redactSecrets } from '@logger/redaction';
import type { SessionEventDraft } from '@shared/schemas';
import { isObject } from '@utils/core';

/** Apply the existing transcript rules before source facts enter the event table. */
export function redactTraceDraft(event: SessionEventDraft): SessionEventDraft {
  switch (event.type) {
    case 'updateStreamDescription':
      return { ...event, description: redactSecrets(event.description) };
    case 'run.config':
      return { ...event, config: redactDisplayValue(event.config) };
    case 'result':
      return { ...event, error: redactLogData(event.error) };
    case 'log':
      return {
        ...event,
        message: redactSecrets(event.message),
        data: redactLogData(event.data),
      };
    case 'stage.start':
      return { ...event, label: redactSecrets(event.label) };
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
 * An error row keeps its provider detail in `data.message` (ErrorLogData), and
 * every host renders that field next to the row text, so it needs the same
 * record-time redaction: a provider error body can echo the request URL or an
 * `Authorization` header.
 *
 * Only a plain payload is rebuilt. A caller may pass a raw `Error` as log data,
 * whose `message` and `stack` are non-enumerable own properties that a spread
 * would silently drop; such an object serializes to `{}` on the wire and on
 * disk anyway, so it is left untouched.
 *
 * The result keeps the input's type: redaction replaces existing string fields
 * with strings and adds no keys.
 */
export function redactLogData<T>(data: T): T {
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
  const redacted: Record<string, string> = {};
  for (const key of [
    'message',
    'rawMessage',
    'rawErrorBody',
    'statusText',
    'partialText',
  ]) {
    const value = data[key];
    if (typeof value === 'string') {
      redacted[key] = redactSecrets(value);
    }
  }
  return { ...data, ...redacted };
}
