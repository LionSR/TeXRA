// Standard library imports
import * as path from 'node:path';

/**
 * Plan produced by base-file and edited-file selection planning.
 *
 * The plan is host-neutral: the caller (FileManager) applies the
 * notifications, logging, and webview messages.
 */
export interface MainViewBaseFileSelectionPlan {
  /** The file path that should be selected in the UI. */
  readonly filePathToSelect: string;
  /** Whether the SET_CURRENT_FILE message should be posted to the webview. */
  readonly shouldPostSetCurrentFile: boolean;
  /** Whether the manager should refresh the base-file dropdown. */
  readonly shouldRequestBaseFile: boolean;
  /** Optional user-facing notification to display. */
  readonly notification?: {
    readonly message: string;
  };
  /** Optional log entry for diagnostics. */
  readonly log?: {
    readonly level: 'info' | 'warn';
    readonly message: string;
  };
}

/**
 * Plan selection when the current open file is treated as a base file.
 *
 * If the current file is a latexdiff file (e.g. `paper-diff1234abcd.tex`),
 * the planner selects the derived base file when it exists on disk, or
 * keeps the current file with a notification when it does not.
 *
 * The caller is responsible for deriving the base file path (via
 * `parseVersionControlDiffFilename`) and checking disk existence (via
 * `WorkspaceFS.exists`). This function only decides what to do with
 * those results.
 *
 * @param currentOpenFile - The path of the currently open editor file.
 * @param derivedBaseFile - The latexdiff-derived base file path, or null
 *   if the current file is not a latexdiff file.
 * @param derivedBaseFileExists - Whether the derived base file exists on disk.
 */
export function planCurrentFileAsBase(
  currentOpenFile: string,
  derivedBaseFile: string | null,
  derivedBaseFileExists: boolean,
): MainViewBaseFileSelectionPlan {
  if (!derivedBaseFile) {
    // Not a latexdiff file, so select the current file as-is.
    return {
      filePathToSelect: currentOpenFile,
      shouldPostSetCurrentFile: true,
      shouldRequestBaseFile: false,
    };
  }

  if (derivedBaseFileExists) {
    return {
      filePathToSelect: derivedBaseFile,
      shouldPostSetCurrentFile: true,
      shouldRequestBaseFile: true,
    };
  }

  return {
    filePathToSelect: currentOpenFile,
    shouldPostSetCurrentFile: true,
    shouldRequestBaseFile: false,
    log: {
      level: 'info',
      message: `Derived base file ${derivedBaseFile} from ${currentOpenFile} does not exist on disk`,
    },
    notification: {
      message: `The base file ${derivedBaseFile} could not be found. Keeping ${currentOpenFile} selected.`,
    },
  };
}

/**
 * Plan selection when the current open file is treated as an edited file.
 *
 * An edited file is valid when its basename starts with the base file's
 * basename but is not identical (e.g. `paper-revised.tex` is a valid
 * edited version of `paper.tex`).
 *
 * @param currentOpenFile - The path of the currently open editor file.
 * @param baseFile - The currently selected base file, if any.
 */
export function planCurrentFileAsEdited(
  currentOpenFile: string,
  baseFile: string | undefined,
): MainViewBaseFileSelectionPlan {
  if (!baseFile) {
    return {
      filePathToSelect: currentOpenFile,
      shouldPostSetCurrentFile: false,
      shouldRequestBaseFile: false,
      notification: {
        message: 'Choose a base file first.',
      },
    };
  }

  const baseFileName = path.basename(baseFile, path.extname(baseFile));
  const currentFileName = path.basename(
    currentOpenFile,
    path.extname(currentOpenFile),
  );

  const isValidEditedFile =
    currentFileName.startsWith(baseFileName) &&
    currentFileName !== baseFileName;

  if (!isValidEditedFile) {
    return {
      filePathToSelect: currentOpenFile,
      shouldPostSetCurrentFile: false,
      shouldRequestBaseFile: false,
      notification: {
        message:
          'The current file is not a valid edited version of the base file.',
      },
    };
  }

  return {
    filePathToSelect: currentOpenFile,
    shouldPostSetCurrentFile: true,
    shouldRequestBaseFile: false,
  };
}
