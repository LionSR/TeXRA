/**
 * Constants and configuration for progress view formatters.
 */

// Re-export icon constants for single import source
export {
  CHEVRON_RIGHT_CLASS,
  CHEVRON_DOWN_CLASS,
} from '@common/iconConstants.js';

// Constants
export const BULLET_MARKUP =
  '<i class="codicon codicon-circle-small-filled group-bullet"></i>';

/** Maximum length for query preview in web search headers */
export const QUERY_PREVIEW_MAX_LENGTH = 40;

export const EMOJI_BY_LEVEL = {
  error: '🔴',
  warn: '🟡',
  info: '🟢',
  debug: '🔍',
};

// DateTimeFormat options for consistent timestamp formatting
export const DATETIME_FORMAT_OPTIONS = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
};

export const TIME_FORMAT_OPTIONS = {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
};
