import * as path from 'node:path';

import { Effect, FileSystem } from 'effect';

import { logFileCategory, logFilesLoaded, type AgentTrace } from '@agent/trace';
import {
  AgentSetting,
  AgentPrompt,
} from '@agent/core/definition/AgentDataclass';
import { userRequestTemplateCount } from '@agent/index/agentYamlScanner';
import {
  USER_VAR_RUNTIME_TOKENS,
  type BuiltUserVars,
} from '@agent/core/definition/AgentCycleOptions';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { ConfigProvider } from '@platform/interfaces';
import type { SettingsStores } from '@shared/config/settingsAccess';
import type {
  AttachedMemoryMiss,
  FileListEntry,
  UserVars,
} from '@shared/schemas';
import {
  AGENT_SKILLS_CONFIG_KEY,
  AgentCategory,
  AgentSkillsEnabledSchema,
} from '@shared/schemas';
import { loadRuntimeSkillCatalog } from '@skills/runtimeSkills';
import { parseFrontmatter } from '@tools/memory/memoryMeta';
import { displayToStoragePath } from '@tools/memory/memoryUtils';
import { filterNotNull, unique } from '@utils/core';
import { isNonEmptyString } from '@utils/text/stringUtils';
import { getListOfFiles, getPromptFileName } from '@utils/prompt';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import {
  listExternalRoots,
  type ExternalRootKind,
} from '@utils/files/externalRoots';
import { readNormalizedFile } from '@utils/files/fsDurability';
import {
  getXmlFormatFromReadableFiles,
  setVarFromFile,
} from '@utils/files/varsUtils';

/** Transient user-variable key carrying the run's live model id. */
export const USER_VAR_MODEL = 'MODEL';
/** Transient user-variable key carrying the current user instruction. */
export const USER_VAR_INSTRUCTION = 'INSTRUCTION';

/** Runtime view of the fixed vocabulary for the required-file collision guard. */
const FIXED_USER_VAR_KEYS: ReadonlySet<string> = new Set(
  USER_VAR_RUNTIME_TOKENS,
);

/**
 * Render the fixed runtime template variables as literal `{{ TOKEN }}` text.
 *
 * Agent-creation templates render once when a YAML file is produced, then the
 * generated agent renders again at runtime. These tokens must pass through the
 * creation render literally so the runtime render can substitute them later.
 * User-defined `requiredFilesInternal` variables are intentionally not in this
 * fixed list; they remain caller-supplied names and `throwOnUndefined` stays
 * disabled until there is a separate validation story for them.
 */
export function buildUserVarPassthrough(): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(
      USER_VAR_RUNTIME_TOKENS.map((token) => [token, `{{ ${token} }}`]),
    ),
  );
}

/**
 * Information about a loaded file for prompt variable substitution.
 * Extends FileListEntry with required source and varName fields.
 * Compatible with FileListEntry (can be passed to AgentTrace.fileList).
 */
type LoadedFileEntry = FileListEntry & {
  source: string;
  varName: string;
};

interface BuildUserVarsOptions {
  /**
   * Workspace root of the session this run belongs to, held as data: prompt
   * file names, the readable-file reads and `CWD` all resolve against it, so
   * a run never reads whichever roots the calling fiber happens to carry.
   * `undefined` is a session with no folder open.
   */
  workspacePath: string | undefined;
  /**
   * Storage root of the same session, held as data for the same reason: the
   * attached memories are read from this project's storage, not from whichever
   * roots the calling fiber carries.
   */
  storageRoot: string;
  /**
   * Configuration of the same session, held as data for the same reason: the
   * skills master switch and the default bibliography path answer for this
   * project, not for whichever roots the calling fiber carries.
   */
  config: ConfigProvider;
  /**
   * The three setting slots of the same session, held as data for the same
   * reason: the run's disabled-skill lists answer for this project, not for
   * whichever roots the calling fiber carries.
   */
  settings: SettingsStores;
  /** Explicit trace stage for diagnostics emitted while loading variables. */
  stageId?: string;
}

/**
 * Agent-defined `requiredFilesInternal` variables: each YAML-named variable
 * `X` contributes a string `X_FILE`/`X_CONTENT` pair. The names are dynamic
 * by design, so they live outside the fixed {@link UserVars} vocabulary.
 */
type RequiredFileVars = Record<string, string>;

/**
 * Result of loading file-based variables
 */
type FileVarsResult = {
  vars: RequiredFileVars;
  files: LoadedFileEntry[];
};

type AttachedMemoriesResult = {
  xml: string | null;
  misses: AttachedMemoryMiss[];
};

/**
 * Build all user variables needed for prompt rendering.
 *
 * @param options.workspacePath - Workspace root of the run's session.
 */
export const buildUserVars = Effect.fn('buildUserVars')(function* (
  agentConfig: AgentConfig,
  agentSetting: AgentSetting,
  agentPrompt: AgentPrompt,
  agentPath: string,
  isAnthropicModel: boolean,
  logger: AgentTrace,
  options: BuildUserVarsOptions,
): Effect.fn.Return<BuiltUserVars, Error, FileSystem.FileSystem> {
  // Parallelize independent I/O: required files, memories, and skills
  const [
    { vars: requiredVars, files: requiredFiles },
    attachedMemories,
    runtimeSkills,
  ] = yield* Effect.all(
    [
      getRequiredFileVars(agentSetting, agentPath),
      getAttachedMemories(agentConfig.memories, options.storageRoot),
      // AVAILABLE_SKILLS is only substituted into TOOL_USE_INSTRUCTIONS, so the
      // catalog (a multi-source readdir + per-skill realpath/read/parse) is dead
      // work for workflow agents. The settings toggle gives users a hard off
      // switch that skips discovery and leaves AVAILABLE_SKILLS empty.
      agentSetting.agentCategory === AgentCategory.ToolUse &&
      AgentSkillsEnabledSchema.parse(
        options.config.get(AGENT_SKILLS_CONFIG_KEY),
      )
        ? loadRuntimeSkillCatalog(options.workspacePath, options.settings)
        : // A fresh object per call, not a shared constant: `skills` is handed
          // to the snapshot consumer, and a shared array would accumulate.
          Effect.succeed({ catalog: '', skills: [], issues: [] }),
    ],
    { concurrency: 'unbounded' },
  );

  for (const issue of runtimeSkills.issues) {
    const location = issue.path ? ` (${issue.path})` : '';
    logger.warn(`Skill import ${issue.severity}: ${issue.message}${location}`, {
      stageId: options.stageId,
    });
  }

  if (agentSetting.agentCategory === AgentCategory.ToolUse) {
    logger.emit({
      type: 'skills.snapshot',
      skills: runtimeSkills.skills,
      stageId: options.stageId,
    });
  }

  // The resolved output list is also the run's normalized `config.outputFiles`:
  // the reflection flow, output validation, and the XML manager all read it
  // back off the config after this point, so the write happens here in the
  // open rather than inside a helper the spread below hides.
  const { outputFiles, vars: outputFileVars } = resolveOutputFiles(
    agentConfig,
    agentSetting,
  );
  agentConfig.outputFiles = outputFiles;

  // Merge all variable sources using spread operator.
  // The custom `requiredFilesInternal` keys ride beside the fixed vocabulary
  // (BuiltUserVars) and reach templates through the channel boundary.
  const userVars: BuiltUserVars = {
    ...getBasicVars(agentConfig, isAnthropicModel, options),
    ...(yield* getFileVars(
      agentConfig,
      agentSetting,
      logger,
      options.workspacePath,
      options.stageId,
    )),
    ...requiredVars,
    ...outputFileVars,
    ...getRoundsVar(agentSetting, agentPrompt),
    ATTACHED_MEMORIES: attachedMemories.xml,
    ATTACHED_MEMORY_MISSES: attachedMemories.misses,
    AVAILABLE_SKILLS: runtimeSkills.catalog,
  };

  // Emit aggregated file list if any files were loaded
  if (requiredFiles.length > 0) {
    logFilesLoaded(logger, 'all', requiredFiles, options.stageId);
  }

  return userVars;
});

type BasicVars = Pick<
  UserVars,
  | 'MODEL'
  | 'INSTRUCTION'
  | 'IS_ANTHROPIC_MODEL'
  | 'CWD'
  | 'DEFAULT_BIB_PATH'
  | 'BUILTIN_WORKFLOW_DIR'
  | 'BUILTIN_TOOLUSE_DIR'
  | 'CUSTOM_AGENTS_DIR'
  | 'AGENT_DOCS_DIR'
>;

function getBasicVars(
  agentConfig: AgentConfig,
  isAnthropicModel: boolean,
  options: BuildUserVarsOptions,
): BasicVars {
  // Get default bib path from settings (empty string if not configured)
  const defaultBibPath = options.config.get<string>('texra.bib.defaultPath');

  return {
    MODEL: agentConfig.model,
    INSTRUCTION: agentConfig.instruction,
    IS_ANTHROPIC_MODEL: isAnthropicModel,
    CWD: options.workspacePath ?? '.',
    DEFAULT_BIB_PATH: defaultBibPath,
    ...getAgentDirectoryVars(),
  };
}

/**
 * Inject the absolute paths of registered agent directories as template
 * variables so agents (notably `creator`) can reference the real paths in
 * their system prompts. Reads from the external-roots registry populated at
 * activation — keyed off the stable `kind` field so renaming a user-visible
 * label cannot break prompt rendering. Absent roots render as empty strings
 * (e.g. in tests that don't run activation).
 */
type AgentDirectoryVars = Pick<
  UserVars,
  | 'BUILTIN_WORKFLOW_DIR'
  | 'BUILTIN_TOOLUSE_DIR'
  | 'CUSTOM_AGENTS_DIR'
  | 'AGENT_DOCS_DIR'
>;

function getAgentDirectoryVars(): AgentDirectoryVars {
  const KIND_TO_VAR: Record<ExternalRootKind, keyof AgentDirectoryVars> = {
    builtInWorkflow: 'BUILTIN_WORKFLOW_DIR',
    builtInToolUse: 'BUILTIN_TOOLUSE_DIR',
    custom: 'CUSTOM_AGENTS_DIR',
    agentDocs: 'AGENT_DOCS_DIR',
  };
  const vars: AgentDirectoryVars = {
    BUILTIN_WORKFLOW_DIR: '',
    BUILTIN_TOOLUSE_DIR: '',
    CUSTOM_AGENTS_DIR: '',
    AGENT_DOCS_DIR: '',
  };
  for (const root of listExternalRoots()) {
    vars[KIND_TO_VAR[root.kind]] = root.absolutePath;
  }
  return vars;
}

// Maps a template prefix to its canonical file-list field.
type FileCategoryConfig = {
  multiple: keyof AgentConfig;
  single?: keyof AgentConfig;
};

const FILE_CATEGORIES: Record<
  FileCategoryPrefix | 'MEDIA',
  FileCategoryConfig
> = {
  INPUT: { multiple: 'inputFiles' },
  CONTEXT: { multiple: 'contextFiles' },
  MEDIA: { multiple: 'mediaFiles' },
  EDITED: { multiple: 'editedFiles', single: 'editedFile' },
};

/** Get the multi-list for a category (filtering empties) */
function getCategoryFiles(
  config: AgentConfig,
  category: FileCategoryPrefix | 'MEDIA',
): string[] {
  const cat = FILE_CATEGORIES[category];
  const list = (config[cat.multiple] as string[] | undefined) ?? [];
  const single = cat.single ? (config[cat.single] as string | null) : null;
  return unique([single, ...list].filter(isNonEmptyString));
}

/** Categories used for building file vars (excludes MEDIA which is display-only) */
type FileCategoryPrefix = 'INPUT' | 'CONTEXT' | 'EDITED';
const FILE_VAR_CATEGORIES: readonly FileCategoryPrefix[] = [
  'INPUT',
  'CONTEXT',
  'EDITED',
];

/**
 * Files-loaded card label per category. `EDITED` is absent because prompt
 * assembly has never emitted a card for it.
 */
const FILE_CATEGORY_CARD_LABEL: Partial<Record<FileCategoryPrefix, string>> = {
  INPUT: 'Input Files',
  CONTEXT: 'Context Files',
};

/** Variables contributed by the readable file categories. */
type FileCategoryVars = {
  [P in FileCategoryPrefix as `${P}_FILE`]: string | null;
} & {
  [P in FileCategoryPrefix as `${P}_CONTENT`]: string | null;
} & {
  [P in FileCategoryPrefix as `${P}_FILES`]: string[];
} & {
  [P in FileCategoryPrefix as `ALL_${P}S`]: string | null;
} & {
  [P in FileCategoryPrefix as `LIST_OF_ALL_${P}S`]: string;
};

/** File-based variables: readable categories plus the display-only MEDIA slots. */
type FileVars = FileCategoryVars & Pick<UserVars, 'MEDIA_FILE'>;

const getFileVars = Effect.fn('userVars.getFileVars')(function* (
  agentConfig: AgentConfig,
  agentSetting: AgentSetting,
  logger: AgentTrace,
  workspaceRoot: string | undefined,
  stageId: string | undefined,
): Effect.fn.Return<FileVars, never, FileSystem.FileSystem> {
  // Compiler-checked completeness: every FileVars key starts at its
  // empty-file default here, so a future FileVars key without a matching
  // default is a type error at this literal. The loop below only overwrites
  // the defaults, and a failed `setVarFromFile` leaves the null pair standing.
  const userVars: FileVars = {
    INPUT_FILE: null,
    INPUT_CONTENT: null,
    CONTEXT_FILE: null,
    CONTEXT_CONTENT: null,
    EDITED_FILE: null,
    EDITED_CONTENT: null,
    INPUT_FILES: [],
    CONTEXT_FILES: [],
    EDITED_FILES: [],
    ALL_INPUTS: null,
    ALL_CONTEXTS: null,
    ALL_EDITEDS: null,
    LIST_OF_ALL_INPUTS: '',
    LIST_OF_ALL_CONTEXTS: '',
    LIST_OF_ALL_EDITEDS: '',
    MEDIA_FILE: null,
  };

  for (const prefix of FILE_VAR_CATEGORIES) {
    const allFiles = getCategoryFiles(agentConfig, prefix);
    const { xml, readableFiles, skipped } =
      allFiles.length > 0
        ? yield* getXmlFormatFromReadableFiles(workspaceRoot, allFiles)
        : { xml: null, readableFiles: [], skipped: [] };
    const primaryFile = readableFiles[0];
    const primaryFileResult =
      primaryFile == null
        ? null
        : yield* setVarFromFile(primaryFile, prefix, workspaceRoot);
    const primaryFileOk = primaryFileResult != null;
    if (primaryFile != null && !primaryFileOk) {
      logger.warn(
        `Failed to load primary file into prompt variables: ${primaryFile}`,
        { stageId },
      );
    }
    if (primaryFileResult != null) {
      userVars[`${prefix}_FILE`] = primaryFileResult.file;
      userVars[`${prefix}_CONTENT`] = primaryFileResult.content;
    }

    // A dropped file changes what the model sees, so report it on the run's own
    // channel rather than leaving it on a module logger nobody reads.
    for (const { file, reason } of skipped) {
      logger.warn(
        `Skipping unreadable file in prompt context: ${file} (${reason})`,
        { stageId },
      );
    }

    // The list rows use the read that fills the list vars. The primary row also
    // reflects the second read that fills its `*_FILE`/`*_CONTENT` pair, so the
    // card cannot report success while those prompt variables remain null.
    //
    // Tool-use agents get no card. Media files are excluded: they have no user
    // vars (display-only in Init) and MediaExtractionNode already logs them
    // with full load results in r0.
    const cardLabel = FILE_CATEGORY_CARD_LABEL[prefix];
    if (
      cardLabel != null &&
      agentSetting.agentCategory !== AgentCategory.ToolUse
    ) {
      const readable = new Set(readableFiles);
      const entries = allFiles.map((file) => ({
        path: file,
        ok: file === primaryFile ? primaryFileOk : readable.has(file),
      }));
      logFileCategory(logger, cardLabel, entries, stageId);
    }

    userVars[`ALL_${prefix}S`] = xml;
    userVars[`${prefix}_FILES`] = readableFiles.map((file) =>
      getPromptFileName(workspaceRoot, file),
    );
    userVars[`LIST_OF_ALL_${prefix}S`] = getListOfFiles(
      workspaceRoot,
      readableFiles,
    );
  }

  const mediaFiles = getCategoryFiles(agentConfig, 'MEDIA');
  userVars.MEDIA_FILE = mediaFiles[0] ?? null;

  return userVars;
});

/**
 * A required-file variable `X` generates the `X_FILE`/`X_CONTENT` pair, which
 * `buildUserVars` spreads after the fixed variables — so a name like `MEDIA`
 * or `INPUT` would silently override a fixed variable. Fail loudly when the
 * variables are built instead.
 */
function assertNoFixedVarCollision(
  varName: string,
): Effect.Effect<void, Error> {
  for (const generatedKey of [`${varName}_FILE`, `${varName}_CONTENT`]) {
    if (FIXED_USER_VAR_KEYS.has(generatedKey)) {
      return Effect.fail(
        new Error(
          `requiredFilesInternal name "${varName}" generates "${generatedKey}", which collides with a fixed template variable. Rename the required-file variable.`,
        ),
      );
    }
  }
  return Effect.void;
}

/**
 * Load the files an agent bundles next to its YAML. Paths are resolved against
 * the agent's directory; an absolute path is used as written.
 */
const getRequiredFileVars = Effect.fn('userVars.getRequiredFileVars')(
  function* (
    agentSetting: AgentSetting,
    agentPath: string,
  ): Effect.fn.Return<FileVarsResult, Error, FileSystem.FileSystem> {
    const vars: RequiredFileVars = {};
    const files: LoadedFileEntry[] = [];

    for (const [varName, filePath] of Object.entries(
      agentSetting.requiredFilesInternal,
    )) {
      if (!filePath) continue;

      yield* assertNoFixedVarCollision(varName);
      const fullPath = path.resolve(agentPath, filePath);
      // Resolved against the agent's own directory, so it is already absolute
      // and needs no workspace root to resolve against.
      const result = yield* setVarFromFile(fullPath, varName, undefined);
      if (result != null) {
        vars[`${varName}_FILE`] = result.file;
        vars[`${varName}_CONTENT`] = result.content;
      }
      files.push({
        path: fullPath,
        ok: result != null,
        varName,
        source: 'requiredFilesInternal',
      });
    }
    return { vars, files };
  },
);

/**
 * Load attached memory files and format them as an XML block for prompt injection.
 * Memory paths are display paths (e.g. /memories/conventions.md).
 * Returns null if no memories are attached.
 */
const getAttachedMemories = Effect.fn('userVars.getAttachedMemories')(
  function* (
    memoryPaths: string[],
    storageRoot: string,
  ): Effect.fn.Return<AttachedMemoriesResult, never, FileSystem.FileSystem> {
    if (memoryPaths.length === 0) return { xml: null, misses: [] };

    const fs = yield* FileSystem.FileSystem;
    const results = yield* Effect.forEach(
      memoryPaths,
      (displayPath) =>
        // `displayToStoragePath` rejects a path outside /memories, which is a
        // miss on that memory rather than a failed prompt build — the same
        // answer a failed read gives.
        Effect.try({
          try: () => path.join(storageRoot, displayToStoragePath(displayPath)),
          catch: ensureError,
        }).pipe(
          Effect.flatMap((target) => readNormalizedFile(fs, target)),
          Effect.map((raw) => {
            // Strip frontmatter metadata — only inject the user-visible content
            const trimmed = parseFrontmatter(raw).content.trim();
            return {
              xml: trimmed
                ? `<memory name="${displayPath}">\n${trimmed}\n</memory>`
                : null,
              miss: null,
            };
          }),
          Effect.catch((error) =>
            Effect.succeed({
              xml: null,
              miss: { path: displayPath, reason: toErrorMessage(error) },
            }),
          ),
        ),
      { concurrency: 'unbounded' },
    );

    const parts = results.map((result) => result.xml).filter(filterNotNull);
    const misses = results.map((result) => result.miss).filter(filterNotNull);
    return {
      xml:
        parts.length > 0
          ? `<attached_memories>\n${parts.join('\n')}\n</attached_memories>`
          : null,
      misses,
    };
  },
);

/**
 * The run's normalized output list plus the prompt variable derived from it.
 * The caller owns writing the list back onto the config; see `buildUserVars`.
 */
function resolveOutputFiles(
  agentConfig: AgentConfig,
  agentSetting: AgentSetting,
): { outputFiles: string[]; vars: Pick<UserVars, 'OUTPUT_FILES'> } {
  const explicitOutputFiles = (agentConfig.outputFiles ?? []).filter(Boolean);
  const defaultOutputFiles = (agentSetting.defaultOutputFiles ?? []).filter(
    Boolean,
  );
  const inputFiles = (agentConfig.inputFiles ?? []).filter(Boolean);
  const explicitFilesAreSubsetOfInputs = explicitOutputFiles.every((file) =>
    inputFiles.includes(file),
  );
  // An empty defaultOutputFiles is already `[]`, so this single ternary covers
  // the "no usable outputs" case without a nested fallback branch.
  const useExplicit =
    explicitOutputFiles.length > 0 && !explicitFilesAreSubsetOfInputs;
  const outputFiles = useExplicit ? explicitOutputFiles : defaultOutputFiles;

  return {
    outputFiles,
    vars: outputFiles.length > 0 ? { OUTPUT_FILES: outputFiles } : {},
  };
}

type RoundsVar = Pick<UserVars, 'ROUNDS'>;

function getRoundsVar(
  agentSetting: AgentSetting,
  agentPrompt: AgentPrompt,
): RoundsVar {
  const flags: RoundsVar = {};

  // Only compute ROUNDS for workflow agents, not tool-use agents
  if (agentSetting.agentCategory !== AgentCategory.ToolUse) {
    const configuredRounds =
      'rounds' in agentSetting ? agentSetting.rounds : undefined;
    flags.ROUNDS = Math.max(
      configuredRounds ?? 2,
      userRequestTemplateCount(agentPrompt.userRequest),
    );
  }

  return flags;
}
