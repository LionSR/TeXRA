// Web Awesome registration entry. Each webview frontend imports this once
// (side-effect only) so the default theme stylesheet and the
// --texra-* -> --wa-* token bridge are available before components are used.
//
// Component imports themselves (e.g. wa-button, wa-input) live alongside the
// component family they belong to — added in subsequent migration PRs. Bundle
// size only grows with the components actually imported.

import '@awesome.me/webawesome/dist/styles/themes/default.css';
import '@shared/styles/wa-tokens.css';
