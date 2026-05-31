export interface ScrollBoundedRows<T> {
  readonly hiddenAfter: number;
  readonly hiddenBefore: number;
  readonly visibleRows: readonly T[];
}

export function maxScrollableRowOffset({
  compactRows,
  maxDisplayLines,
  totalLines,
}: {
  readonly compactRows: number;
  readonly maxDisplayLines: number;
  readonly totalLines: number;
}): number {
  if (maxDisplayLines <= compactRows || totalLines <= maxDisplayLines) {
    return 0;
  }
  return Math.max(0, totalLines - Math.max(1, maxDisplayLines - 1));
}

export function scrollBoundedRows<T>({
  compactRows,
  maxDisplayLines,
  rows,
  scrollOffset = 0,
}: {
  readonly compactRows: number;
  readonly maxDisplayLines: number;
  readonly rows: readonly T[];
  readonly scrollOffset?: number;
}): ScrollBoundedRows<T> {
  if (maxDisplayLines <= 0 || rows.length <= maxDisplayLines) {
    return { hiddenAfter: 0, hiddenBefore: 0, visibleRows: rows };
  }

  if (maxDisplayLines <= compactRows) {
    const visibleRows = rows.slice(0, Math.max(0, maxDisplayLines));
    return {
      hiddenAfter: Math.max(0, rows.length - visibleRows.length),
      hiddenBefore: 0,
      visibleRows,
    };
  }

  const offset = Math.max(
    0,
    Math.min(
      scrollOffset,
      maxScrollableRowOffset({
        compactRows,
        maxDisplayLines,
        totalLines: rows.length,
      }),
    ),
  );
  const hiddenBefore = offset;
  const reserveBefore = hiddenBefore > 0 ? 1 : 0;
  const contentSlotsWithoutAfter = Math.max(0, maxDisplayLines - reserveBefore);
  const reserveAfter = offset + contentSlotsWithoutAfter < rows.length ? 1 : 0;
  const visibleCount = Math.max(
    0,
    maxDisplayLines - reserveBefore - reserveAfter,
  );
  const visibleRows = rows.slice(offset, offset + visibleCount);
  const hiddenAfter = Math.max(0, rows.length - (offset + visibleCount));

  return { hiddenAfter, hiddenBefore, visibleRows };
}
