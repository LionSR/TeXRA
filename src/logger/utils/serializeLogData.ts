// Third-party imports
// (none)

// Local imports - types
// (none)

export function serializeLogData(data: unknown): unknown {
  if (data instanceof Error) {
    return { name: data.name, message: data.message, stack: data.stack };
  }
  return data;
}

