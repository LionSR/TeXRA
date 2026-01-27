// Third-party imports
import { createContext } from '@lit/context';

// Local imports - main view
import type { SessionType } from '../constants';

// Local imports - shared schemas
import type {
  AgentOptionData,
  CheckboxValues,
  ModelOptionData,
} from '@shared/schemas';

export interface FileStateContextValue {
  sessionType: SessionType;
  checkboxValues: CheckboxValues;
  singleFiles: {
    inputFile: string;
    referenceFile: string;
    auxiliaryFile: string;
    mediaFile: string;
    baseFile: string;
    editedFile: string;
  };
  fileOptions: {
    inputFile: string[];
    referenceFile: string[];
    auxiliaryFile: string[];
    mediaFile: string[];
    baseFile: string[];
    editedFile: string[];
  };
  multiFiles: {
    inputFiles: string[];
    referenceFiles: string[];
    auxiliaryFiles: string[];
    mediaFiles: string[];
    outputFiles: string[];
  };
  multiFilesVisible: {
    inputFiles: boolean;
    referenceFiles: boolean;
    auxiliaryFiles: boolean;
    mediaFiles: boolean;
    outputFiles: boolean;
  };
  outputFilesActive: boolean;
}

export interface SessionContextValue {
  sessionType: SessionType;
  instruction: string;
  placeholder: string;
  workflowAgent: string;
  toolUseAgent: string;
  model: string;
  workflowAgentOptionsHtml: string;
  toolUseAgentOptionsHtml: string;
  modelOptionsHtml: string;
  workflowAgentOptions: AgentOptionData[];
  toolUseAgentOptions: AgentOptionData[];
  modelOptions: ModelOptionData[];
  isRecording: boolean;
  isPolishing: boolean;
  debugMode: boolean;
}

export const fileStateContext = createContext<FileStateContextValue>(
  'main-view-file-state',
);

export const sessionContext =
  createContext<SessionContextValue>('main-view-session');
