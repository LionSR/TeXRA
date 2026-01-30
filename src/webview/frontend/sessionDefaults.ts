// Local imports - main view defaults
import {
  DEFAULT_CHECKBOX_VALUES,
  DEFAULT_MULTI_FILES,
  DEFAULT_MULTI_FILES_VISIBLE,
  DEFAULT_SINGLE_FILES,
} from './store';
import { SESSION_TYPES } from './constants';

// Local imports - shared schemas
import type {
  CheckboxValues,
  MultiFiles,
  MultiFilesVisible,
  SingleFiles,
  SessionType,
} from '@shared/schemas';

export interface SessionDefaults {
  fileInputEnabled: boolean;
  resetFiles: boolean;
  singleFiles: SingleFiles;
  multiFiles: MultiFiles;
  multiFilesVisible: MultiFilesVisible;
  checkboxValues: CheckboxValues;
  outputFilesActive: boolean;
}

export const SESSION_DEFAULTS = {
  [SESSION_TYPES.WORKFLOW]: {
    fileInputEnabled: true,
    resetFiles: true,
    singleFiles: DEFAULT_SINGLE_FILES,
    multiFiles: DEFAULT_MULTI_FILES,
    multiFilesVisible: DEFAULT_MULTI_FILES_VISIBLE,
    checkboxValues: DEFAULT_CHECKBOX_VALUES,
    outputFilesActive: false,
  },
  [SESSION_TYPES.TOOL_USE]: {
    fileInputEnabled: false,
    resetFiles: false,
    singleFiles: DEFAULT_SINGLE_FILES,
    multiFiles: DEFAULT_MULTI_FILES,
    multiFilesVisible: DEFAULT_MULTI_FILES_VISIBLE,
    checkboxValues: DEFAULT_CHECKBOX_VALUES,
    outputFilesActive: false,
  },
} satisfies Record<SessionType, SessionDefaults>;
