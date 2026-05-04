import { readdir } from 'node:fs/promises';
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';

import { getWorkspaceProvider } from '@agent/core/workspace';
import { MAIN_VIEW_COMMANDS } from '@common/webview/mainViewCommands';
import { DEFAULT_TEXRA_SETTINGS } from '@shared/schemas/settingsConfiguration';
import { normalizeFilePath } from '@shared/utils/path';
import { getConfig } from '@utils/config/configUtils';

type ExtensionCategory =
  | 'input'
  | 'reference'
  | 'auxiliary'
  | 'media'
  | 'audio'
  | 'edited';

type ListableFileType = Exclude<ExtensionCategory, 'audio'>;

interface FileListConfig {
  extensions: string[];
  ignoredExtensions: string[];
  ignoredDirs: string[];
  ignoredKeywords: string[];
  ignoredFiles: string[];
}

export interface DesktopFileSelectionDialogOptions {
  title: string;
  defaultPath?: string;
  filters: Array<{ name: string; extensions: string[] }>;
}

export interface DesktopFileSelectionOptions {
  postToRenderer(message: unknown): void;
  getWorkspacePath?: () => string | undefined;
  showOpenFileDialog?: (
    options: DesktopFileSelectionDialogOptions,
  ) => Promise<string | undefined>;
}

export interface DesktopFileSelection {
  handleMessage(
    message: { command: string } & Record<string, unknown>,
  ): boolean;
}

const RESPONSE_BY_SELECT_COMMAND = {
  [MAIN_VIEW_COMMANDS.SELECT_INPUT_FILE]:
    MAIN_VIEW_COMMANDS.INPUT_FILE_SELECTED,
  [MAIN_VIEW_COMMANDS.SELECT_REFERENCE_FILE]:
    MAIN_VIEW_COMMANDS.REFERENCE_FILE_SELECTED,
  [MAIN_VIEW_COMMANDS.SELECT_AUXILIARY_FILE]:
    MAIN_VIEW_COMMANDS.AUXILIARY_FILE_SELECTED,
  [MAIN_VIEW_COMMANDS.SELECT_MEDIA_FILE]:
    MAIN_VIEW_COMMANDS.MEDIA_FILE_SELECTED,
} as const;

const TYPE_BY_SELECT_COMMAND = {
  [MAIN_VIEW_COMMANDS.SELECT_INPUT_FILE]: 'input',
  [MAIN_VIEW_COMMANDS.SELECT_REFERENCE_FILE]: 'reference',
  [MAIN_VIEW_COMMANDS.SELECT_AUXILIARY_FILE]: 'auxiliary',
  [MAIN_VIEW_COMMANDS.SELECT_MEDIA_FILE]: 'media',
} as const;

const SET_COMMAND_BY_FILE_TYPE = {
  input: MAIN_VIEW_COMMANDS.SET_INPUT_FILE,
  reference: MAIN_VIEW_COMMANDS.SET_REFERENCE_FILE,
  auxiliary: MAIN_VIEW_COMMANDS.SET_AUXILIARY_FILE,
  media: MAIN_VIEW_COMMANDS.SET_MEDIA_FILE,
  edited: MAIN_VIEW_COMMANDS.SET_EDITED_FILE,
  base: MAIN_VIEW_COMMANDS.SET_BASE_FILE,
} as const;

const INCLUDED_EXTENSION_KEYS: Record<ExtensionCategory, string> = {
  input: 'texra.files.included.inputExtensions',
  reference: 'texra.files.included.referenceExtensions',
  auxiliary: 'texra.files.included.auxiliaryExtensions',
  media: 'texra.files.included.mediaExtensions',
  audio: 'texra.files.included.audioExtensions',
  edited: 'texra.files.included.editedExtensions',
};

function normalizeRelative(filePath: string): string {
  return normalizeFilePath(filePath);
}

function cleanList(values: readonly string[]): string[] {
  return values.map((value) => value.toLowerCase());
}

function configuredList(key: string, fallback: string[]): string[] {
  return getConfig<string[]>(key, fallback);
}

function extensionDefaults(category: ExtensionCategory): string[] {
  const { included } = DEFAULT_TEXRA_SETTINGS.files;
  switch (category) {
    case 'input':
      return included.inputExtensions;
    case 'reference':
      return included.referenceExtensions;
    case 'auxiliary':
      return included.auxiliaryExtensions;
    case 'media':
      return included.mediaExtensions;
    case 'edited':
      return included.editedExtensions;
    case 'audio':
      return [];
  }
}

function getConfiguredExtensions(category: ExtensionCategory): string[] {
  return getConfig<string[]>(
    INCLUDED_EXTENSION_KEYS[category],
    extensionDefaults(category),
  );
}

function getListConfig(fileType: ListableFileType): FileListConfig | null {
  if (fileType === 'edited') return null;

  const ignored = DEFAULT_TEXRA_SETTINGS.files.ignored;
  const ignoredFileExtensions = configuredList(
    'texra.files.ignored.fileExtensions',
    ignored.fileExtensions,
  );
  const ignoredDirectories = configuredList(
    'texra.files.ignored.directories',
    ignored.directories,
  );
  const ignoredKeywords = configuredList(
    'texra.files.ignored.keywords',
    ignored.keywords,
  );
  const ignoredInputFiles = configuredList(
    'texra.files.ignored.inputFiles',
    ignored.inputFiles,
  );
  const ignoredInputDirectories = configuredList(
    'texra.files.ignored.inputDirectories',
    ignored.inputDirectories,
  );
  const ignoredAuxKeywords = configuredList(
    'texra.files.ignored.auxiliaryKeywords',
    ignored.auxiliaryKeywords,
  );
  const ignoredMediaDirs = configuredList(
    'texra.files.ignored.mediaDirectories',
    ignored.mediaDirectories,
  );

  switch (fileType) {
    case 'input':
      return {
        extensions: getConfiguredExtensions('input'),
        ignoredExtensions: ignoredFileExtensions,
        ignoredDirs: [...ignoredDirectories, ...ignoredInputDirectories],
        ignoredKeywords,
        ignoredFiles: ignoredInputFiles,
      };
    case 'reference':
      return {
        extensions: getConfiguredExtensions('reference'),
        ignoredExtensions: ignoredFileExtensions,
        ignoredDirs: ignoredDirectories,
        ignoredKeywords,
        ignoredFiles: ignoredInputFiles,
      };
    case 'auxiliary':
      return {
        extensions: getConfiguredExtensions('auxiliary'),
        ignoredExtensions: ignoredFileExtensions,
        ignoredDirs: ignoredDirectories,
        ignoredKeywords: [...ignoredKeywords, ...ignoredAuxKeywords],
        ignoredFiles: [],
      };
    case 'media':
      return {
        extensions: getConfiguredExtensions('media'),
        ignoredExtensions: [],
        ignoredDirs: ignoredMediaDirs,
        ignoredKeywords,
        ignoredFiles: [],
      };
  }
}

function containsHiddenSegment(relativePath: string): boolean {
  return relativePath
    .split('/')
    .some((segment) => segment.startsWith('.') && segment.length > 1);
}

function passesFilters(relativePath: string, config: FileListConfig): boolean {
  if (!relativePath || containsHiddenSegment(relativePath)) return false;
  const lowerPath = relativePath.toLowerCase();
  const fileName = basename(lowerPath);
  const dirs = lowerPath.split('/').slice(0, -1);
  const ignoredDirs = cleanList(config.ignoredDirs);

  if (dirs.some((segment) => ignoredDirs.includes(segment))) return false;
  if (cleanList(config.ignoredFiles).includes(fileName)) return false;
  if (cleanList(config.ignoredKeywords).some((kw) => lowerPath.includes(kw))) {
    return false;
  }
  if (
    cleanList(config.ignoredExtensions).some((ext) => lowerPath.endsWith(ext))
  ) {
    return false;
  }

  const included = cleanList(config.extensions);
  return (
    included.length === 0 || included.some((ext) => lowerPath.endsWith(ext))
  );
}

async function listFiles(
  root: string,
  config: FileListConfig,
): Promise<string[]> {
  const results: string[] = [];

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const relativePath = normalizeRelative(relative(root, absolutePath));
      if (entry.isDirectory()) {
        if (!containsHiddenSegment(relativePath)) {
          await visit(absolutePath);
        }
        continue;
      }
      if (entry.isFile() && passesFilters(relativePath, config)) {
        results.push(relativePath);
      }
    }
  }

  await visit(root);
  return results.sort((a, b) => a.localeCompare(b));
}

function resolveWorkspaceFile(workspacePath: string, filePath: string): string {
  return isAbsolute(filePath) ? filePath : resolve(workspacePath, filePath);
}

function toWorkspaceRelative(workspacePath: string, filePath: string): string {
  const absolutePath = resolveWorkspaceFile(workspacePath, filePath);
  const relativePath = relative(workspacePath, absolutePath);
  return relativePath.startsWith('..') || isAbsolute(relativePath)
    ? absolutePath
    : normalizeRelative(relativePath);
}

function outputExtensionsFor(fileType: ListableFileType): string[] {
  return getConfiguredExtensions(fileType).map((ext) => ext.replace(/^\./, ''));
}

export function createDesktopFileSelection(
  options: DesktopFileSelectionOptions,
): DesktopFileSelection {
  const getWorkspacePath =
    options.getWorkspacePath ??
    (() => getWorkspaceProvider().getWorkspacePath());

  function postFileList(
    fileType: keyof typeof SET_COMMAND_BY_FILE_TYPE,
    files: string[],
  ) {
    options.postToRenderer({
      command: SET_COMMAND_BY_FILE_TYPE[fileType],
      files,
    });
  }

  async function list(fileType: ListableFileType): Promise<string[]> {
    const workspacePath = getWorkspacePath();
    const config = getListConfig(fileType);
    if (!workspacePath || !config) return [];
    return listFiles(workspacePath, config);
  }

  async function requestSingleFileList(
    fileType: keyof typeof SET_COMMAND_BY_FILE_TYPE,
  ) {
    const files =
      fileType === 'base'
        ? await list('input')
        : await list(fileType as ListableFileType);
    postFileList(fileType, files);
  }

  async function requestAllSingleFiles() {
    const [inputFiles, referenceFiles, auxiliaryFiles, mediaFiles] =
      await Promise.all([
        list('input'),
        list('reference'),
        list('auxiliary'),
        list('media'),
      ]);
    options.postToRenderer({
      command: MAIN_VIEW_COMMANDS.SET_ALL_SINGLE_FILES,
      inputFiles,
      referenceFiles,
      auxiliaryFiles,
      mediaFiles,
    });
  }

  async function selectSingleFile(
    command: keyof typeof TYPE_BY_SELECT_COMMAND,
  ) {
    const workspacePath = getWorkspacePath();
    if (!workspacePath || !options.showOpenFileDialog) return;
    const fileType = TYPE_BY_SELECT_COMMAND[command];
    const selected = await options.showOpenFileDialog({
      title: `Select ${fileType} file`,
      defaultPath: workspacePath,
      filters: [
        {
          name: `${fileType} files`,
          extensions: outputExtensionsFor(fileType),
        },
      ],
    });
    if (!selected) return;
    options.postToRenderer({
      command: RESPONSE_BY_SELECT_COMMAND[command],
      filePath: toWorkspaceRelative(workspacePath, selected),
    });
  }

  async function updateEditedFiles(baseFile?: string) {
    if (!baseFile) {
      postFileList('edited', []);
      return;
    }
    const workspacePath = getWorkspacePath();
    const config = {
      extensions: getConfiguredExtensions('edited'),
      ignoredExtensions: configuredList(
        'texra.files.ignored.fileExtensions',
        DEFAULT_TEXRA_SETTINGS.files.ignored.fileExtensions,
      ),
      ignoredDirs: [
        ...configuredList(
          'texra.files.ignored.directories',
          DEFAULT_TEXRA_SETTINGS.files.ignored.directories,
        ),
        ...configuredList(
          'texra.files.ignored.inputDirectories',
          DEFAULT_TEXRA_SETTINGS.files.ignored.inputDirectories,
        ),
      ],
      ignoredKeywords: configuredList(
        'texra.files.ignored.keywords',
        DEFAULT_TEXRA_SETTINGS.files.ignored.keywords,
      ),
      ignoredFiles: configuredList(
        'texra.files.ignored.inputFiles',
        DEFAULT_TEXRA_SETTINGS.files.ignored.inputFiles,
      ),
    };
    if (!workspacePath) {
      postFileList('edited', []);
      return;
    }
    const baseName = basename(baseFile, extname(baseFile));
    const baseNameWithoutRound =
      baseName.match(/^(.+?)(?:_r\d+)?$/)?.[1] ?? baseName;
    const files = (await listFiles(workspacePath, config)).filter((file) => {
      const fileBase = basename(file, extname(file));
      return (
        fileBase !== baseName &&
        (fileBase.startsWith(baseName) ||
          (fileBase.startsWith(baseNameWithoutRound) && /_r\d+/.test(fileBase)))
      );
    });
    postFileList('edited', files);
  }

  function handleMessage(
    message: { command: string } & Record<string, unknown>,
  ): boolean {
    switch (message.command) {
      case MAIN_VIEW_COMMANDS.REQUEST_INPUT_FILE:
        void requestSingleFileList('input');
        return true;
      case MAIN_VIEW_COMMANDS.REQUEST_REFERENCE_FILE:
        void requestSingleFileList('reference');
        return true;
      case MAIN_VIEW_COMMANDS.REQUEST_AUXILIARY_FILE:
        void requestSingleFileList('auxiliary');
        return true;
      case MAIN_VIEW_COMMANDS.REQUEST_MEDIA_FILE:
        void requestSingleFileList('media');
        return true;
      case MAIN_VIEW_COMMANDS.REQUEST_BASE_FILE:
        void requestSingleFileList('base');
        return true;
      case MAIN_VIEW_COMMANDS.REFRESH_ALL_FILES:
        void requestAllSingleFiles();
        return true;
      case MAIN_VIEW_COMMANDS.SELECT_INPUT_FILE:
      case MAIN_VIEW_COMMANDS.SELECT_REFERENCE_FILE:
      case MAIN_VIEW_COMMANDS.SELECT_AUXILIARY_FILE:
      case MAIN_VIEW_COMMANDS.SELECT_MEDIA_FILE:
        void selectSingleFile(message.command);
        return true;
      case MAIN_VIEW_COMMANDS.INPUT_FILE_SELECTED:
        void updateEditedFiles(
          typeof message.filePath === 'string' ? message.filePath : undefined,
        );
        return true;
      case MAIN_VIEW_COMMANDS.REQUEST_EDITED_FILE:
        void updateEditedFiles(
          typeof message.baseFile === 'string' ? message.baseFile : undefined,
        );
        return true;
      case MAIN_VIEW_COMMANDS.REQUEST_RECENT_COMMITS:
        options.postToRenderer({
          command: MAIN_VIEW_COMMANDS.SET_RECENT_COMMITS,
          commits: [],
          isGitRepo: false,
        });
        return true;
      default:
        return false;
    }
  }

  return { handleMessage };
}
