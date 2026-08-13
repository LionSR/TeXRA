// Local imports - webview constants
import type { CheckboxValues } from '@shared/schemas';
import type { SessionType } from './constants';

interface SessionDefaults {
  fileInputEnabled: boolean;
  resetFiles: boolean;
  checkboxOverrides?: Partial<CheckboxValues>;
}

export const SESSION_DEFAULTS = {
  workflow: {
    fileInputEnabled: true,
    resetFiles: true,
    checkboxOverrides: {
      autoExtractFigure: false,
      autoExtractTikzFigure: false,
      autoCompileInputPdf: false,
    },
  },
  toolUse: {
    fileInputEnabled: false,
    resetFiles: false,
  },
} satisfies Record<SessionType, SessionDefaults>;
