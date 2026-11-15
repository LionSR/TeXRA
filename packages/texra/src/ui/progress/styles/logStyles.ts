/**
 * Combined log styles for ProgressView Shadow DOM components.
 */

// Third-party imports
import { css } from 'lit';
import katexStyles from 'katex/dist/katex.min.css?inline';

// Shared styles
import { commonViewStyles } from '@ui/styles';
import { markdownStyles } from '@ui/styles/markdownStyles';
import { lineChangeStatsStyles } from '@ui/styles/surfaceStyles';
import { toneStyles } from '@ui/styles/toneStyles';

// Import individual style modules
import { logEntryStyles } from './logEntryStyles';
import { stageStyles } from './stageStyles';
import { codeBlockStyles } from './codeBlockStyles';
import { toolUseStyles } from './toolUseStyles';

const katexStyleSheet = new CSSStyleSheet();
katexStyleSheet.replaceSync(katexStyles);

/**
 * Layout styles for Shadow DOM host and child elements.
 * These ensure proper flex layout for the log display hierarchy.
 */
export const layoutStyles = css`
  :host,
  stage-list {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
    contain: layout style paint;
  }

  stage-list > .log-container {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    contain: layout paint;
  }

  user-message {
    display: block;
  }
`;

/**
 * Combined log styles - includes layout and all modular styles.
 * Use this for components that need the full set of log styles.
 */
export const logStyles = [
  commonViewStyles,
  katexStyleSheet,
  layoutStyles,
  logEntryStyles,
  stageStyles,
  codeBlockStyles,
  toolUseStyles,
  markdownStyles,
  lineChangeStatsStyles,
  toneStyles,
];
