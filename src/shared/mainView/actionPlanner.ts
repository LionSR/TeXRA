// Local imports - IPC
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import type {
  MergeMessage,
  CompareMessage,
  LatexdiffMessage,
  LatexdiffvcMessage,
  PackMultipleMessage,
  PackLatexdiffvcMessage,
} from '@shared/schemas/mainView/inbound';

// Local imports - utilities
import { capitalize } from '@utils/text/stringUtils';

// ============================================================
// Common result types
// ============================================================

interface ActionValidationError {
  readonly valid: false;
  readonly message: string;
}

interface CommandSuccess<
  T extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly valid: true;
  readonly command: string;
  readonly payload: T;
}

export interface ActionSuccess<
  T extends Record<string, unknown> = Record<string, unknown>,
> extends CommandSuccess<T> {
  readonly infoText: string;
}

export type ActionResult<
  T extends Record<string, unknown> = Record<string, unknown>,
> = ActionSuccess<T> | ActionValidationError;

// ============================================================
// Pack/Clean
// ============================================================

export interface PackCleanState {
  readonly primaryInput: string;
  readonly model: string;
  readonly inputFiles: readonly string[];
  readonly agent: string;
}

export type PackCleanPayload = Omit<PackMultipleMessage, 'command'>;

export function planPackClean(
  state: PackCleanState,
  action: 'pack' | 'clean',
): ActionResult<PackCleanPayload> {
  if (!state.primaryInput || !state.model) {
    return {
      valid: false,
      message: 'Please select all required fields (input file and model)',
    };
  }

  const filteredInputs = state.inputFiles.filter(Boolean);
  const additionalInputFiles = filteredInputs.slice(1);
  const useMultiple = additionalInputFiles.length > 0;

  let command: string;
  if (action === 'pack') {
    command = useMultiple
      ? MAIN_VIEW_COMMANDS.PACK_MULTIPLE
      : MAIN_VIEW_COMMANDS.PACK_SINGLE;
  } else {
    command = useMultiple
      ? MAIN_VIEW_COMMANDS.CLEAN_MULTIPLE
      : MAIN_VIEW_COMMANDS.CLEAN_SINGLE;
  }

  const actionLabel = capitalize(action);
  const infoText = useMultiple
    ? `${actionLabel}ing multiple files: ${filteredInputs.join(', ')}`
    : `${actionLabel}ing single file: ${state.primaryInput}`;

  return {
    valid: true,
    command,
    payload: {
      inputFile: state.primaryInput,
      agent: state.agent,
      model: state.model,
      inputFiles: useMultiple ? additionalInputFiles : undefined,
    },
    infoText,
  };
}

// ============================================================
// Merge
// ============================================================

export interface MergeState {
  readonly primaryInput: string;
  readonly editedFile: string;
}

export type MergePayload = Omit<MergeMessage, 'command'>;

export function planMerge(state: MergeState): ActionResult<MergePayload> {
  if (!state.primaryInput || !state.editedFile) {
    return {
      valid: false,
      message: 'Please select both input and edited files to merge',
    };
  }

  return {
    valid: true,
    command: MAIN_VIEW_COMMANDS.MERGE,
    payload: {
      inputFile: state.primaryInput,
      editedFile: state.editedFile,
    },
    infoText: `Merging files: ${state.primaryInput} and ${state.editedFile}`,
  };
}

// ============================================================
// Compare
// ============================================================

export interface CompareState {
  readonly baseFile: string;
  readonly editedFile: string;
}

type ComparePayload = Omit<CompareMessage, 'command'>;

export type CompareActionResult =
  CommandSuccess<ComparePayload> | ActionValidationError;

export function planCompare(
  state: CompareState,
  command: string,
): CompareActionResult {
  if (!state.baseFile || !state.editedFile) {
    return {
      valid: false,
      message: 'Please select both base and edited files to compare',
    };
  }

  return {
    valid: true,
    command,
    payload: {
      baseFile: state.baseFile,
      editedFile: state.editedFile,
    },
  };
}

// ============================================================
// Latexdiff
// ============================================================

export interface LatexdiffState {
  readonly inputFile: string;
  readonly baseFile: string;
  readonly editedFile: string;
}

export type LatexdiffPayload = Omit<LatexdiffMessage, 'command'>;

export function planLatexdiff(
  state: LatexdiffState,
): ActionSuccess<LatexdiffPayload> {
  return {
    valid: true,
    command: MAIN_VIEW_COMMANDS.LATEXDIFF,
    payload: {
      inputFile: state.inputFile,
      baseFile: state.baseFile,
      editedFile: state.editedFile,
    },
    infoText: `Running LaTeX diff between ${state.baseFile} and ${state.editedFile}`,
  };
}

// ============================================================
// LatexdiffVC
// ============================================================

export interface LatexdiffVCState {
  readonly inputFile: string;
  readonly baseFile: string;
  readonly commitHash: string;
}

export type LatexdiffVCPayload = Omit<LatexdiffvcMessage, 'command'>;

export function planLatexdiffVC(
  state: LatexdiffVCState,
): ActionSuccess<LatexdiffVCPayload> {
  return {
    valid: true,
    command: MAIN_VIEW_COMMANDS.LATEXDIFFVC,
    payload: {
      inputFile: state.inputFile,
      baseFile: state.baseFile,
      commitHash: state.commitHash,
    },
    infoText: `Running LaTeX diff with version control: ${state.baseFile} at commit ${state.commitHash}`,
  };
}

// ============================================================
// LatexdiffVC Pack/Clean
// ============================================================

export type LatexdiffVCPackPayload = Omit<PackLatexdiffvcMessage, 'command'>;

export function planLatexdiffVCPack(
  state: LatexdiffVCState,
  action: 'pack' | 'clean',
): ActionSuccess<LatexdiffVCPackPayload> {
  const command =
    action === 'pack'
      ? MAIN_VIEW_COMMANDS.PACK_LATEXDIFFVC
      : MAIN_VIEW_COMMANDS.CLEAN_LATEXDIFFVC;

  const actionLabel = capitalize(action);

  return {
    valid: true,
    command,
    payload: {
      inputFile: state.inputFile,
      baseFile: state.baseFile,
      commitHash: state.commitHash,
      clean: action === 'clean',
    },
    infoText: `${actionLabel}ing LaTeX diff with version control: ${state.baseFile} at commit ${state.commitHash}`,
  };
}
