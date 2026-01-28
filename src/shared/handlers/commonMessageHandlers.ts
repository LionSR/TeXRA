import {
  CommonViewMessageSchema,
  type StateRestoreMessage,
} from '@shared/schemas/commonViewMessages';
import { COMMON_COMMANDS } from '@common/webview/commands';
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

  switch (result.data.command) {
    case COMMON_COMMANDS.THEME_SET:
      context.setTheme(result.data.theme);
      return true;
    case COMMON_COMMANDS.DEBUG_MODE_SET:
      context.setDebugMode(result.data.debugMode);
      return true;
    case COMMON_COMMANDS.STATE_RESTORE:
      context.restoreState(result.data);
      return true;
    case COMMON_COMMANDS.ERROR:
      context.onError(result.data.message, result.data.details);
      return true;
    case COMMON_COMMANDS.WEBVIEW_READY:
      return true;
    default:
      return false;
  }
}
