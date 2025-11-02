// Third-party imports
// (none)

// Local imports - types
// (none)

const EMOJI_BY_LEVEL: Record<string, string> = {
  error: '🔴',
  warn: '🟡',
  info: '🟢',
  debug: '🔍',
};

export function getColorForLevel(level: string): string {
  return EMOJI_BY_LEVEL[level.toLowerCase()] ?? '•';
}

