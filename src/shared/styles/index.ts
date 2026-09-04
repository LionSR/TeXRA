// Public door onto the shared Lit style sheets the webview frontends compose
// into their components — the common view chrome, design tokens, and the
// handful of widely-reused component sheets below. This is a documented
// exception to "no convenience barrels": components pull `commonViewStyles`
// and friends from here instead of naming each sheet's file, because nearly
// every view composes the same handful of sheets. A module stays out of this
// barrel (and gets a direct import instead) when it has few consumers or is
// reached indirectly through another export — see the two call-outs below.

// Core styles
export {
  commonViewStyles,
  visuallyHiddenDeclarations,
  visuallyHiddenStyles,
} from './commonViewStyles';
export { designTokens } from './litStyles';

// The canonical button/input/focus-ring/settings-row skins reach consumers
// through `commonViewStyles` (which interpolates them), so they are not
// re-exported here. Components that compose a narrower sheet — e.g. a split
// button without the full common view — import from './controlStyles' directly.
//
// Two modules are deliberately NOT re-exported from this barrel:
// - './markdownStyles' — renderer-specific sheet; only components that mount
//   rendered markdown compose it, so it stays a direct import.
// - './statusIndicatorStyles' — single-purpose 8px status dot with one
//   consumer (the progress-view stream header).

// Component styles
export { selectStyles, compactFormControlStyles } from './selectStyles';
export { requestPanelSharedStyles, sp } from './requestPanelSharedStyles';
export { viewHeaderLayoutStyles, viewTabStyles } from './viewHeaderStyles';

// Shared inline wa-callout banner chrome (agent-config, api-key, dependency,
// login, getting-started, workflow-hint banners)
export { bannerStyles, settingsBannerStyles } from './bannerStyles';
