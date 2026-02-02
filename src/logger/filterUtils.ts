import { MESSAGE_TYPES, type MessageType } from '@shared/schemas';
import { getConfig } from '@utils/config';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export function getEmitFilter(options: {
  level: LogLevel;
  messageType: MessageType;
}): {
  shouldEmit: boolean;
  debugMode: boolean;
} {
  const debugMode = getConfig<boolean>('texra.logger.debugMode', false);
  return {
    shouldEmit:
      options.messageType !== MESSAGE_TYPES.INTERNAL &&
      (options.level !== 'debug' || debugMode),
    debugMode,
  };
}
