/**
 * Document slice: host-pushed file lists, single-file selections, commits,
 * and opened-file merges.
 */

// Local imports - shared IPC and schemas
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import type { MainViewHandlerRegistry, MainViewMessage } from '@shared/schemas';
import {
  DocumentFileTypeSchema,
  isMultipleDocumentFileType,
  type DocumentFileType,
} from '@shared/schemas/fileTypes';
import { unique } from '@utils/core';

// Local imports - main view
import {
  commit$,
  fileOptions$,
  isGitRepo$,
  multiFiles$,
  singleFiles$,
} from '../mainViewState';
import { showInformation, updateMultiFiles } from '../mainViewActions';
import {
  MULTI_FILE_LIST_BY_SET_COMMAND,
  MULTI_FILE_LISTS,
  SINGLE_FILE_TYPE_TO_KEY,
} from '../store';

// Helper type for extracting specific message type from union
type MainViewMessageFor<C extends MainViewMessage['command']> = Extract<
  MainViewMessage,
  { command: C }
>;

type SetMultipleFilesMessage =
  | MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.SET_INPUT_FILES>
  | MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.SET_CONTEXT_FILES>
  | MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.SET_MEDIA_FILES>
  | MainViewMessageFor<typeof MAIN_VIEW_COMMANDS.SET_OUTPUT_FILES>;

function handleSetMultipleFiles(message: SetMultipleFilesMessage): void {
  const files = message.files ?? [];
  const list = MULTI_FILE_LIST_BY_SET_COMMAND[message.command];

  multiFiles$.set({ ...multiFiles$.get(), [list.key]: files });
}

// File-local (not exported): narrows a `CurrentFileType` to `DocumentFileType`
// via the schema itself, so a future addition to `DocumentFileTypeSchema`
// takes effect here without a matching hand-written literal check.
const DOCUMENT_FILE_TYPES = new Set<string>(DocumentFileTypeSchema.options);
function isDocumentFileType(value: string): value is DocumentFileType {
  return DOCUMENT_FILE_TYPES.has(value);
}

/** Check if a commit hash exists in the options array. */
function hasCommitValue(value: string): boolean {
  if (!value) return false;
  return (fileOptions$.get().commit ?? []).some((commit) => {
    const [hash] = commit.split(': ');
    return hash === value;
  });
}

// `satisfies Partial<...>` subset — owns only document commands; see
// bannerSlice.ts for the rationale.
export const documentHandlers = {
  [MAIN_VIEW_COMMANDS.SET_EDITED_FILE]: (message) => {
    const files = message.files ?? [];
    fileOptions$.set({ ...fileOptions$.get(), editedFile: files });
    const currentValue = singleFiles$.get().editedFile;
    if (currentValue && !files.includes(currentValue)) {
      singleFiles$.set({ ...singleFiles$.get(), editedFile: '' });
    }
  },

  [MAIN_VIEW_COMMANDS.SET_BASE_FILE]: (message) => {
    const files = message.files ?? [];
    fileOptions$.set({ ...fileOptions$.get(), baseFile: files });

    if (
      !message.preserveBaseFile &&
      !files.includes(singleFiles$.get().baseFile)
    ) {
      singleFiles$.set({ ...singleFiles$.get(), baseFile: '' });
    }
  },

  [MAIN_VIEW_COMMANDS.SET_INPUT_FILES]: handleSetMultipleFiles,
  [MAIN_VIEW_COMMANDS.SET_CONTEXT_FILES]: handleSetMultipleFiles,
  [MAIN_VIEW_COMMANDS.SET_MEDIA_FILES]: handleSetMultipleFiles,
  [MAIN_VIEW_COMMANDS.SET_OUTPUT_FILES]: handleSetMultipleFiles,

  [MAIN_VIEW_COMMANDS.ADD_MEDIA_FILE]: (message) => {
    const file = message.file;
    const mf = multiFiles$.get();
    const existing = mf.mediaFiles;
    if (existing.includes(file)) return;
    multiFiles$.set({
      ...mf,
      mediaFiles: [...existing, file],
    });
  },

  [MAIN_VIEW_COMMANDS.SET_RECENT_COMMITS]: (message) => {
    const commits = message.commits;
    const gitRepo = message.isGitRepo ?? true;
    isGitRepo$.set(gitRepo);

    // Store the list the picker renders verbatim: `HEAD` is always selectable
    // in a repository, so it is added here rather than by every reader.
    const withHead = commits.some((commit) => commit.startsWith('HEAD'))
      ? commits
      : ['HEAD', ...commits];
    fileOptions$.set({
      ...fileOptions$.get(),
      commit: gitRepo ? withHead : [],
    });

    const currentCommit = commit$.get();
    if (!gitRepo) {
      commit$.set('');
    } else if (!currentCommit || !hasCommitValue(currentCommit)) {
      commit$.set('HEAD');
    }
  },

  [MAIN_VIEW_COMMANDS.SET_CURRENT_FILE]: (message) => {
    const { fileType, filePath } = message;
    if (!filePath) return;

    // Workflow categories (input/context/media): prepend the active editor's
    // file to the multi-list head so it becomes the "primary" file.
    if (isDocumentFileType(fileType)) {
      const listId = MULTI_FILE_LISTS[fileType].key;
      const existing = multiFiles$.get()[listId];
      const next = [filePath, ...existing.filter((f) => f !== filePath)];
      updateMultiFiles(listId, next);
      return;
    }

    // Base/edited are single-slot fields: they select out of fileOptions.
    const key = SINGLE_FILE_TYPE_TO_KEY[fileType];
    if (!key) return;
    const sf = singleFiles$.get();
    const options = fileOptions$.get()[key] ?? [];
    if (!options.includes(filePath)) {
      showInformation(
        `The current file is not in the ${fileType} file list: ${filePath}`,
      );
      return;
    }
    singleFiles$.set({ ...sf, [key]: filePath });
  },

  [MAIN_VIEW_COMMANDS.SET_SELECTED_COMMIT]: (message) => {
    const commitHash = message.commitHash;
    const commitLabel = message.commitLabel ?? '';

    if (!commitHash) return;
    const fo = fileOptions$.get();
    const options = fo.commit ?? [];
    if (!options.some((option) => option.startsWith(commitHash))) {
      fileOptions$.set({
        ...fo,
        commit: [...options, commitLabel || commitHash],
      });
    }
    commit$.set(commitHash);
  },

  [MAIN_VIEW_COMMANDS.SET_OPENED_FILES]: (message) => {
    if (!isMultipleDocumentFileType(message.fileType)) return;
    const listId = MULTI_FILE_LISTS[message.fileType].key;

    const mf = multiFiles$.get();
    const filesToAdd = message.files ?? [];
    const merged = unique([...mf[listId], ...filesToAdd]);
    multiFiles$.set({ ...mf, [listId]: merged });
  },
} satisfies Partial<MainViewHandlerRegistry>;
