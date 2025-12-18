import { serializeError } from '@utils/core';

export function serializeLogData(data: unknown): unknown {
  if (data === null || data === undefined) {
    return data;
  }
  if (data instanceof Error) {
    return serializeError(data);
  }
  return data;
}
