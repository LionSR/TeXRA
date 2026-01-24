// Local imports
import { safeFormat, resolveOpenState } from './baseLogFormatter';
import { normalizeStructuredContent } from './normalizers';
import {
  formatBannerContent,
  formatModelResponse,
} from './logFormatters/bannerFormatters';
import { formatToolUse, formatWebSearch } from './logFormatters/toolFormatters';
import {
  formatFileList,
  formatMissingOutputs,
  formatLatexdiff,
  formatStatistics,
} from './logFormatters/dataFormatters';
import { formatContextManagement } from './logFormatters/contextManagementFormatters';
import {
  formatUserMessage,
  formatProgressStatus,
  formatError,
  formatDefaultLogMessage,
} from './logFormatters/messageFormatters';

export interface LogFormatOptions {
  preservedOpen?: boolean;
  defaultOpen?: boolean;
}

export class LogEntryFormatter {
  private autoExpandedTypes = new Set(['thinking', 'scratchpad']);
  private nullableTypes = new Set([
    'thinking',
    'scratchpad',
    'modelResponse',
    'contextState',
  ]);

  private buildFormatterMap() {
    const safe =
      (fn: (message: any) => string | null, label: string) => (message: any) =>
        safeFormat(() => fn(message), label);

    const withPayloadId =
      (fn: (payload: any, id: string) => string | null) => (message: any) =>
        fn(message.normalizedPayload, message.id);

    const withFullMeta =
      (
        fn: (
          payload: any,
          id: string,
          groupId?: string,
          timestamp?: number,
        ) => string | null,
      ) =>
      (message: any) =>
        fn(
          message.normalizedPayload,
          message.id,
          message.groupId,
          message.timestamp,
        );

    const banner = (title: 'Thinking' | 'Scratchpad') =>
      withFullMeta((payload, id, gid, ts) =>
        formatBannerContent(payload, title, id, gid, ts),
      );

    return {
      thinking: safe(banner('Thinking'), 'thinking'),
      scratchpad: safe(banner('Scratchpad'), 'scratchpad'),
      toolUse: safe(withFullMeta(formatToolUse), 'tool use'),
      webSearch: safe(withFullMeta(formatWebSearch), 'web search'),
      modelResponse: safe(
        (m: any) =>
          formatModelResponse({
            id: m.id,
            groupId: m.groupId,
            timestamp: m.timestamp,
            verbose: m.verbose,
            content: m.normalizedPayload,
            level: m.level,
          }),
        'Assistant',
      ),
      fileList: safe(withPayloadId(formatFileList), 'file list'),
      missingOutputs: safe(
        withPayloadId(formatMissingOutputs),
        'missing outputs',
      ),
      latexdiff: safe(withPayloadId(formatLatexdiff), 'latexdiff'),
      statistics: safe(withPayloadId(formatStatistics), 'statistics'),
      contextManagement: safe(
        withPayloadId(formatContextManagement),
        'context management',
      ),
      contextState: () => null,
      userMessage: safe(
        (m: any) => formatUserMessage(m.normalizedPayload, m.id, m.timestamp),
        'user message',
      ),
      progressStatus: safe(formatProgressStatus, 'progress status'),
      error: safe(formatError, 'error'),
    } as const;
  }

  private formatters = this.buildFormatterMap();

  format(logMessage: any, options?: LogFormatOptions): string | null {
    const messageWithPayload = {
      ...logMessage,
      normalizedPayload: normalizeStructuredContent(
        logMessage.text,
        logMessage.data,
      ),
    };

    const { messageType } = messageWithPayload;
    const formatter = messageType
      ? this.formatters[messageType as keyof typeof this.formatters]
      : null;

    if (typeof formatter === 'function') {
      const result = formatter(messageWithPayload);
      if (result) {
        return result;
      }

      if (messageType && this.nullableTypes.has(messageType)) {
        return null;
      }
    }

    return formatDefaultLogMessage(messageWithPayload);
  }

  resolveOpenState(messageType: string, options?: LogFormatOptions) {
    return resolveOpenState(messageType, options, this.autoExpandedTypes);
  }
}

let sharedFormatter: LogEntryFormatter | undefined;

export const getSharedLogEntryFormatter = (): LogEntryFormatter => {
  if (!sharedFormatter) {
    sharedFormatter = new LogEntryFormatter();
  }
  return sharedFormatter;
};
