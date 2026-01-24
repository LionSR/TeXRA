import type { LogMessageData } from '@shared/schemas';

export interface LogFormatterOptions {
  preservedOpen?: boolean;
  defaultOpen?: boolean;
}

export class LogEntryFormatter {
  format(
    log: LogMessageData,
    options?: LogFormatterOptions,
  ): HTMLElement | null;
}

export class TaskGroupHeaderFormatter {
  create(group: unknown): HTMLElement | null;
}

export function formatTokens(tokens: number): string;
export function getSharedLogEntryFormatter(): LogEntryFormatter;
