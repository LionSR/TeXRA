export type SessionTitleState = 'idle' | 'running' | 'approval';

/**
 * Host-specific vocabulary and density for one title surface. A terminal tab
 * is a few characters wide and competes with sibling tabs, so it gets the
 * brand mark and glyph markers; a native window title has room for words.
 */
export interface SessionTitleStyle {
  /** Product name as rendered: compact mark or spelled-out name. */
  readonly brand: string;
  /** Placed between the brand and the project name. */
  readonly separator: string;
  /** State marker, or `undefined` to leave that state unmarked. */
  readonly marker: Record<SessionTitleState, string | undefined>;
}

export const TERMINAL_TAB_TITLE: SessionTitleStyle = {
  brand: '{T}',
  separator: '·',
  marker: { idle: undefined, running: '⠋', approval: '⚠' },
};

export const NATIVE_WINDOW_TITLE: SessionTitleStyle = {
  brand: 'TeXRA',
  separator: ' · ',
  marker: { idle: undefined, running: 'Running', approval: 'Approval needed' },
};

export interface SessionTitleOptions {
  /** Live activity, e.g. a spinner frame; REPLACES the running marker. */
  readonly detail?: string;
  readonly style: SessionTitleStyle;
}

/**
 * Format the product title shared by native windows and terminal tabs:
 * `⠋ {T}·proj`. The state marker leads so it survives tab truncation, and a
 * live `detail` frame stands in for the running marker — an animated frame
 * already says "running", so no redundant word beside it.
 */
export function formatSessionTitle(
  project: string | undefined,
  state: SessionTitleState,
  options: SessionTitleOptions,
): string {
  const { detail, style } = options;
  // A live frame stands in for the running marker; other states keep theirs.
  const marker =
    state === 'running'
      ? (detail ?? style.marker.running)
      : style.marker[state];
  const head = marker ? `${marker} ${style.brand}` : style.brand;
  return project ? `${head}${style.separator}${project}` : head;
}
