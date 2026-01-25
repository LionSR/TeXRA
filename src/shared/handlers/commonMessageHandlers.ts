// Local imports - shared schemas
import {
  CommonViewMessageSchema,
  type CommonViewMessage,
  type StateRestoreMessage,
} from '@shared/schemas/commonViewMessages';

// Local imports - shared commands
import { COMMON_COMMANDS } from '@common/webview/commands';

// Type imports
import type { ZodError } from 'zod';

export interface CommonMessageContext {
  setTheme: (theme: string) => void;
  setDebugMode: (enabled: boolean) => void;
  restoreState: (message: StateRestoreMessage) => void;
  onError: (message: string, details?: unknown) => void;
  onSchemaError?: (context: string, error: ZodError) => void;
}

export function handleCommonMessage(
  raw: unknown,
  context: CommonMessageContext,
): boolean {
  const result = CommonViewMessageSchema.safeParse(raw);
  if (!result.success) {
    context.onSchemaError?.(
      '[CommonMessage] Schema validation failed.',
      result.error,
    );
    return false;
  }

  const message: CommonViewMessage = result.data;
  switch (message.command) {
    case COMMON_COMMANDS.THEME_SET:
      context.setTheme(message.theme);
      return true;
    case COMMON_COMMANDS.DEBUG_MODE_SET:
      context.setDebugMode(message.debugMode);
      return true;
    case COMMON_COMMANDS.STATE_RESTORE:
      context.restoreState(message);
      return true;
    case COMMON_COMMANDS.ERROR:
      context.onError(message.message, message.details ?? undefined);
      return true;
    case COMMON_COMMANDS.WEBVIEW_READY:
      return true;
    default:
      return false;
  }
}
