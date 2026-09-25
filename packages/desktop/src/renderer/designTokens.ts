// The shared semantic tokens and canonical controls for the document's own
// (light DOM) tree: the same sheets every component adopts for its shadow
// root, so the two trees have one definition and cannot drift.
// themeTokens.css supplies only the --desktop-* palette and the --wa-* inputs
// these read. Imported for its effect by each renderer entry.
//
// Adopted sheets cascade after the document's own, so the shared base goes
// in a layer: any unlayered renderer rule then refines it, whatever order
// the sheets load in.
import { designTokens } from '@ui/styles';
import {
  buttonStyles,
  focusRingStyles,
  formControlStyles,
  iconSurfaceStyles,
  settingsRowStyles,
} from '@ui/styles/controlStyles';

const shared = new CSSStyleSheet();
shared.replaceSync(
  `@layer shared {\n${[
    designTokens,
    focusRingStyles,
    buttonStyles,
    iconSurfaceStyles,
    formControlStyles,
    settingsRowStyles,
  ]
    .map((sheet) => sheet.cssText)
    .join('\n')}\n}`,
);
document.adoptedStyleSheets = [...document.adoptedStyleSheets, shared];
