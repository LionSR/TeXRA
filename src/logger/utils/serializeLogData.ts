import { serializeError } from '@utils/core';

export function serializeLogData(data: unknown): unknown {
  return data instanceof Error ? serializeError(data) : data;
}
