export function getTimeFormatter(): Intl.DateTimeFormat;
export function getDateTimeFormatter(): Intl.DateTimeFormat;
export function formatTimestamp(date: Date): {
  fullTimestamp: string;
  timeDisplay: string;
  tooltipTimestamp: string;
};
export function formatTokens(tokens: number): string;
export function formatDuration(durationMs: number): string;

export class MessageTimestampExtractor {
  extract(element: HTMLElement): string;
}
