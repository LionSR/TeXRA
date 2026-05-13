import { LOG_LEVELS, type LogLevel } from '@shared/schemas';

const EMOJI_BY_LEVEL: Record<LogLevel, string> = {
  [LOG_LEVELS.ERROR]: '🔴',
  [LOG_LEVELS.WARN]: '🟡',
  [LOG_LEVELS.INFO]: '🟢',
  [LOG_LEVELS.DEBUG]: '🔍',
};

export function getColorForLevel(level: LogLevel): string {
  return EMOJI_BY_LEVEL[level];
}
