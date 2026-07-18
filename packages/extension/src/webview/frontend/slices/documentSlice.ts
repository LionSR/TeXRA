/**
 * Document slice: host-pushed file lists, single-file selections, commits,
 * and opened-file merges.
 */

// Local imports - shared IPC and schemas
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import type {
  FileOptions,
  MainViewHandlerRegistry,
  MainViewMessage,
  MultiFiles,
} from '@shared/schemas';
import { unique } from '@utils/core';

// Local imports - main view
import { DOCUMENT_FILE_TYPES, type DocumentFileType } from '../constants';
import {
  commit$,
  fileOptions$,
  isGitRepo$,
  multiFiles$,
  singleFiles$,
} from '../mainViewState';
import { showInformation, updateMultiFiles } from '../mainViewActions';
import { saveState } from '../persistence';
import { MULTI_FILE_COMMAND_TO_KEY } from '../store';

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
  const listId = MULTI_FILE_COMMAND_TO_KEY[message.command] as keyof MultiFiles;
  if (!listId) return;

  multiFiles$.set({ ...multiFiles$.get(), [listId]: files });
  saveState();
}

/** Check if a commit hash exists in the options array. */
function hasCommitValue(value: string): boolean {
  if (!value) return false;
  const commits = fileOptions$.get().commit ?? [];
  const entries = commits.some((commit) => commit.startsWith('HEAD'))
    ? commits
    : ['HEAD', ...commits];
  return entries.some((commit) => {
    const [hash] = commit.split(': ');
    return hash === value;
  });
}

// `satisfies Partial<...>` (not `: MainViewHandlerRegistry`): this slice
// owns only document commands; see bannerSlice.ts for why (registry is now
// exhaustive, messageDispatcher.ts is the real coverage checkpoint).
export const documentHandlers = {
  [MAIN_VIEW_COMMANDS.SET_EDITED_FILE]: (message) => {
    const files = message.files ?? [];
    fileOptions$.set({ ...fileOptions$.get(), editedFile: files });
    const currentValue = singleFiles$.get().editedFile;
    if (currentValue && !files.includes(currentValue)) {
      singleFiles$.set({ ...singleFiles$.get(), editedFile: '' });
    }
    saveState();
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

    saveState();
  },

  [MAIN_VIEW_COMMANDS.EDITED_FILE_SELECTED]: (message) => {
    singleFiles$.set({
      ...singleFiles$.get(),
      editedFile: message.filePath,
    });
    saveState();
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
    saveState();
  },

  [MAIN_VIEW_COMMANDS.SET_RECENT_COMMITS]: (message) => {
    const commits = message.commits;
    const gitRepo = message.isGitRepo ?? true;
    isGitRepo$.set(gitRepo);

    fileOptions$.set({
      ...fileOptions$.get(),
      commit: gitRepo ? commits : [],
    });

    const currentCommit = commit$.get();
    if (!gitRepo) {
      commit$.set('');
    } else if (!currentCommit || !hasCommitValue(currentCommit)) {
      commit$.set('HEAD');
    }
    saveState();
  },

  [MAIN_VIEW_COMMANDS.SET_CURRENT_FILE]: (message) => {
    const { fileType, filePath } = message;
    if (!filePath) return;

    // Workflow categories (input/context/media): prepend the active editor's
    // file to the multi-list head so it becomes the "primary" file.
    if (DOCUMENT_FILE_TYPES.includes(fileType as DocumentFileType)) {
      const listId = `${fileType}Files` as keyof MultiFiles;
      const mf = multiFiles$.get();
      const existing = mf[listId] ?? [];
      const next = [filePath, ...existing.filter((f) => f !== filePath)];
      updateMultiFiles(listId, next);
      return;
    }

    // Base/edited single-slot fields go through fileOptions like before.
    const key = `${fileType}File` as keyof FileOptions;
    const sf = singleFiles$.get();
    if (!(key in sf)) return;
    const options = fileOptions$.get()[key] ?? [];
    if (!options.includes(filePath)) {
      showInformation(
        `The current file is not in the ${fileType} file list: ${filePath}`,
      );
      return;
    }
    singleFiles$.set({ ...sf, [key]: filePath });
    saveState();
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
    saveState();
  },

  [MAIN_VIEW_COMMANDS.SET_OPENED_FILES]: (message) => {
    const fileType = message.fileType;
    const normalizedType = fileType.endsWith('Files')
      ? fileType
      : `${fileType}Files`;
    const listId = normalizedType as keyof MultiFiles;
    const mf = multiFiles$.get();
    if (!(listId in mf)) return;

    const filesToAdd = message.files ?? [];
    const existing = mf[listId] ?? [];
    const merged = unique([...existing, ...filesToAdd]);
    multiFiles$.set({ ...mf, [listId]: merged });
    saveState();
  },
} satisfies Partial<MainViewHandlerRegistry>;
