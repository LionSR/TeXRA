import { LOG_LEVELS, type LogLevel } from '@shared/schemas';

const EMOJI_BY_LEVEL: Record<LogLevel, string> = {
  [LOG_LEVELS.ERROR]: '🔴',
  [LOG_LEVELS.WARN]: '🟡',
  [LOG_LEVELS.INFO]: '🟢',
  [LOG_LEVELS.DEBUG]: '🔍',
};

export function getColorForLevel(level: string): string {
  const normalizedLevel = level.toLowerCase() as LogLevel;
  return EMOJI_BY_LEVEL[normalizedLevel] ?? '•';
}
