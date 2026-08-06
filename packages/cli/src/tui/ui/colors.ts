import { cliEnvValue } from '@cli/runtime/cliContext';

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

// A named ANSI colour carries no lightness guarantee — the terminal owns the
// value, and the sixteen are tuned for dark backgrounds. Which roles need a
// light-background substitute is measured, not assumed: against white, red,
// blue, magenta and gray hold Lc 66-91 on the xterm, macOS Basic and VS Code
// Light+ palettes and are left alone, while green, yellow and cyan collapse to
// Lc 30-47 (WCAG 1.70-2.56:1), under the Lc 60 floor for non-body text.
//
// The three substitutes are one derivation rather than three picks: oklch
// lightness 0.48 at each role's own hue, chroma at the sRGB gamut boundary.
// Shared lightness is what makes them a scale; only the hue differs.
//
//   role       hue    value      Lc on #ffffff / #f5f5f5
//   success    150    #007132    80.1 / 74.2
//   warning     75    #7f5400    82.5 / 76.5
//   hint       220    #006980    80.8 / 74.9
//
// COLORFGBG is "<fg>;<bg>"; some terminals insert extra fields, so the
// background is always the last one, and 7 (light gray) and 15 (white) are the
// only light backgrounds terminals report. Terminals that never set it
// (Terminal.app, iTerm2, Alacritty) fall through to the dark assumption the
// ANSI names are already tuned for, so this can only improve a light terminal,
// never regress a dark one. Resolved once here so every call site keeps
// consuming a plain string.
const LIGHT_TERMINAL_BACKGROUND = ((): boolean => {
  const background = cliEnvValue('COLORFGBG')?.split(';').at(-1);
  return background === '7' || background === '15';
})();

/** Positive/affirmative state: completed tool runs, "agent asks" prompts. */
export const COLOR_SUCCESS = LIGHT_TERMINAL_BACKGROUND ? '#007132' : 'green';

/** Caution: retryable failures, bash/edit auto-approval, queued/empty states. */
export const COLOR_WARNING = LIGHT_TERMINAL_BACKGROUND ? '#7f5400' : 'yellow';

/** Failure/destructive state: errors, non-zero exit codes, the yolo policy. */
export const COLOR_ERROR = 'red';

/** Default informational emphasis: form/panel borders, headings, previews. */
export const COLOR_HINT = LIGHT_TERMINAL_BACKGROUND ? '#006980' : 'cyan';

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
