// Semantic color palette for the CLI TUI. Components say WHAT (semantic
// color); this module says WHICH Ink/chalk color name backs it — so
// re-theming or contrast-tuning happens in one owned place instead of at
// each of the dozens of `color="cyan"` / `borderColor="yellow"` call sites
// this replaces (see TeXRA#8118).
//
// Ink's `color`/`borderColor` props accept any chalk color name typed as
// `LiteralUnion<ForegroundColorName, string>`. These constants are typed as
// plain string literals (not chalk's own `ForegroundColorName`) to match the
// existing `BorderedPanel`/`ConfirmCard`/`FormFrame` `color: string` props —
// chalk is only a transitive dependency of `ink` here, not one the CLI
// declares directly.

/** Positive/affirmative state: completed tool runs, "agent asks" prompts. */
export const COLOR_SUCCESS = 'green';

/** Caution: retryable failures, bash/edit auto-approval, queued/empty states. */
export const COLOR_WARNING = 'yellow';

/** Failure/destructive state: errors, non-zero exit codes, the yolo policy. */
export const COLOR_ERROR = 'red';

/** Default informational emphasis: form/panel borders, headings, previews. */
export const COLOR_HINT = 'cyan';

/** Distinctive one-off highlight: reverse-search mode, agent-proposal review. */
export const COLOR_ACCENT = 'magenta';

/** Secondary informational callout, distinct from the default hint (used to
 *  set the plan-review card apart from the edit/bash approval cards). */
export const COLOR_INFO = 'blue';

/** Neutral chrome with no semantic weight: the idle input box border and
 *  the neutral cancelled/stopped subagent status marker (a user stop is
 *  neither success nor failure — see TeXRA#8115/#8188). */
export const COLOR_BORDER = 'gray';

// Not migrated onto this palette — decided in TeXRA#8118:
//  - `render/DiffView.tsx`'s hex constants are paired background+foreground
//    bands tuned for WCAG contrast on both light and dark terminals, not
//    single named colors; they stay a self-contained diff-band style.
//  - `render/ansiMarkdown.ts`'s picocolors usage renders raw ANSI strings
//    (not Ink `color` props) and is already centralized in one local
//    `ansiMarkdownStyle()` factory; picocolors' `createColors(enabled)` gate
//    doesn't compose with plain color-name constants.
