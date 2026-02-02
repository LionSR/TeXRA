// Local imports - webview constants
import type { SessionType } from './constants';
import type { CheckboxValues } from '@shared/schemas';

export interface SessionDefaults {
  fileInputEnabled: boolean;
  resetFiles: boolean;
  checkboxOverrides?: Partial<CheckboxValues>;
  outputFilesActive?: boolean;
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
    outputFilesActive: false,
  },
  toolUse: {
    fileInputEnabled: false,
    resetFiles: false,
  },
} satisfies Record<SessionType, SessionDefaults>;
