// (none)

// (none)

export function serializeLogData(data: unknown): unknown {
  if (data === null || data === undefined) {
    return data;
  }
  if (data instanceof Error) {
    return { name: data.name, message: data.message, stack: data.stack };
  }
  return data;
}
