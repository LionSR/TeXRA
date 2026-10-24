import * as path from 'node:path';

import { Effect, FileSystem, Predicate, Schema } from 'effect';

import type { AgentTrace } from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { isTrustedScript } from '@agent/core/definition/RunRecord';
import type { AttachedMemoryMiss } from '@shared/schemas';
import { activatedSkillNames } from '@skills/runtimeSkills';
import { parseFrontmatter } from '@tools/memory/memoryMeta';
import { displayToStoragePath } from '@tools/memory/memoryUtils';
import { getListOfFiles, getPromptFileName } from '@utils/prompt';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import {
  listExternalRoots,
  type ExternalRootKind,
} from '@utils/files/externalRoots';
import { readNormalizedFile } from '@utils/files/fsDurability';
import { getXmlFormatFromReadableFiles } from '@utils/files/varsUtils';

/**
 * The fixed template vocabulary {@link buildTemplateInputs} produces to
 * render an agent's prompts at launch: one validator per runtime token, and
 * the single source of truth for the vocabulary. The object is closed on
 * purpose: a misspelled fixed variable is a compile error at the producer
 * and at every typed reader instead of a silently empty substitution.
 * Nothing persists it: a tool-use run records the text it rendered, and
 * what follows the step (the tool-call mechanics, the skills) is rendered
 * per request (`stepInstructions`).
 *
 * A plugin may render its own templates with more variables beside these
 * (see {@link TemplateVars}); they are not in this vocabulary.
 */
const TemplateInputsSchema = Schema.Struct({
  /** The launch instruction. */
  INSTRUCTION: Schema.String,
  /** Provider gate for Anthropic-specific agent prompt blocks. */
  IS_ANTHROPIC_MODEL: Schema.Boolean,
  /** Workspace root the run operates in. */
  CWD: Schema.String,
  /** Absolute agent-directory paths from the external-roots registry, '' when unregistered. */
  BUILTIN_AGENTS_DIR: Schema.String,
  CUSTOM_AGENTS_DIR: Schema.String,
  AGENT_DOCS_DIR: Schema.String,
  /** Per-category primary file and its content, null when none is readable. */
  INPUT_FILE: Schema.NullOr(Schema.String),
  INPUT_CONTENT: Schema.NullOr(Schema.String),
  CONTEXT_FILE: Schema.NullOr(Schema.String),
  CONTEXT_CONTENT: Schema.NullOr(Schema.String),
  EDITED_FILE: Schema.NullOr(Schema.String),
  EDITED_CONTENT: Schema.NullOr(Schema.String),
  /** Per-category readable files as prompt-displayed names. */
  INPUT_FILES: Schema.Array(Schema.String),
  CONTEXT_FILES: Schema.Array(Schema.String),
  EDITED_FILES: Schema.Array(Schema.String),
  /** Per-category XML bundle of readable files, null when none are readable. */
  ALL_INPUTS: Schema.NullOr(Schema.String),
  ALL_CONTEXTS: Schema.NullOr(Schema.String),
  ALL_EDITEDS: Schema.NullOr(Schema.String),
  /** Per-category comma-separated readable file list, '' when empty. */
  LIST_OF_ALL_INPUTS: Schema.String,
  LIST_OF_ALL_CONTEXTS: Schema.String,
  LIST_OF_ALL_EDITEDS: Schema.String,
  /** First attached media file; content is never inlined (display-only). */
  MEDIA_FILE: Schema.NullOr(Schema.String),
  /** The run's output file list; absent when it has none. */
  OUTPUT_FILES: Schema.optional(Schema.Array(Schema.String)),
});

/** The fixed variables every prompt template may read. */
export type TemplateInputs = typeof TemplateInputsSchema.Type;

/**
 * The template-variable map accepted at the render boundary (PromptBuilder):
 * fixed variables may be absent (template rendering keeps `throwOnUndefined`
 * off, so templates must tolerate absence), and a plugin's own variables add
 * custom keys beside the fixed ones.
 */
export type TemplateVars = Partial<TemplateInputs> & Record<string, unknown>;

/** The fixed vocabulary as a runtime list; its reader builds a map from it,
 *  so its order is irrelevant. */
const TEMPLATE_INPUT_TOKENS = Object.keys(
  TemplateInputsSchema.fields,
) as (keyof TemplateInputs)[];

/**
 * Render the fixed runtime template variables as literal `{{ TOKEN }}` text.
 *
 * Agent-creation templates render once when a YAML file is produced, then the
 * generated agent renders again at runtime. These tokens must pass through the
 * creation render literally so the runtime render can substitute them later.
 * A plugin's own variables are not in this fixed list; `throwOnUndefined`
 * stays disabled, so a template tolerates their absence.
 */
export function buildTemplatePassthrough(): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(
      TEMPLATE_INPUT_TOKENS.map((token) => [token, `{{ ${token} }}`]),
    ),
  );
}

/**
 * The roots of the session this run belongs to, held as data, so a run never
 * reads whichever roots the calling fiber carries: the workspace that prompt
 * file names, file reads and `CWD` resolve against (`undefined` with no
 * folder open), the storage its attached memories live in, and the
 * configuration and setting slots its skills switch and disabled-skill lists
 * answer from.
 */
interface BuildTemplateInputsOptions {
  workspacePath: string | undefined;
  storageRoot: string;
}

type AttachedMemoriesResult = {
  xml: string | null;
  misses: AttachedMemoryMiss[];
};

/**
 * What a launch opens from: the template inputs; the names of the skills a
 * tool-use run's instruction activated; the attached memories' XML block,
 * appended to the system prompt (null when none are attached); and the
 * attached memories that could not be read.
 */
export interface TemplateOpening {
  readonly inputs: TemplateVars;
  readonly activated: readonly string[];
  readonly attachedMemories: string | null;
  readonly attachedMemoryMisses: AttachedMemoryMiss[];
}

/**
 * Build what a launch renders its prompts from.
 *
 * @param options.workspacePath - Workspace root of the run's session.
 */
export const buildTemplateInputs = Effect.fn('buildTemplateInputs')(function* (
  agentConfig: AgentConfig,
  isAnthropicModel: boolean,
  logger: AgentTrace,
  options: BuildTemplateInputsOptions,
): Effect.fn.Return<TemplateOpening, never, FileSystem.FileSystem> {
  const attachedMemories = yield* getAttachedMemories(
    agentConfig.memories,
    options.storageRoot,
  );
  const inputs: TemplateInputs = {
    ...getBasicVars(agentConfig, isAnthropicModel, options),
    ...(yield* getFileVars(agentConfig, logger, options.workspacePath)),
    // `prepareAgentDefinition` normalized the list.
    ...(agentConfig.outputFiles.length > 0
      ? { OUTPUT_FILES: agentConfig.outputFiles }
      : {}),
  };

  return {
    inputs,
    // What the launch instruction activates (`/skills`): each step resolves
    // the names against its own catalog; a trusted script's, none.
    activated: isTrustedScript(agentConfig)
      ? []
      : activatedSkillNames([agentConfig.instruction]),
    attachedMemories: attachedMemories.xml,
    attachedMemoryMisses: attachedMemories.misses,
  };
});

type BasicVars = Pick<
  TemplateInputs,
  | 'INSTRUCTION'
  | 'IS_ANTHROPIC_MODEL'
  | 'CWD'
  | 'BUILTIN_AGENTS_DIR'
  | 'CUSTOM_AGENTS_DIR'
  | 'AGENT_DOCS_DIR'
>;

function getBasicVars(
  agentConfig: AgentConfig,
  isAnthropicModel: boolean,
  options: BuildTemplateInputsOptions,
): BasicVars {
  return {
    INSTRUCTION: agentConfig.instruction,
    IS_ANTHROPIC_MODEL: isAnthropicModel,
    CWD: options.workspacePath ?? '.',
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
  TemplateInputs,
  'BUILTIN_AGENTS_DIR' | 'CUSTOM_AGENTS_DIR' | 'AGENT_DOCS_DIR'
>;

function getAgentDirectoryVars(): AgentDirectoryVars {
  const KIND_TO_VAR: Record<ExternalRootKind, keyof AgentDirectoryVars> = {
    builtIn: 'BUILTIN_AGENTS_DIR',
    custom: 'CUSTOM_AGENTS_DIR',
    agentDocs: 'AGENT_DOCS_DIR',
  };
  const vars: AgentDirectoryVars = {
    BUILTIN_AGENTS_DIR: '',
    CUSTOM_AGENTS_DIR: '',
    AGENT_DOCS_DIR: '',
  };
  for (const root of listExternalRoots())
    vars[KIND_TO_VAR[root.kind]] = root.absolutePath;
  return vars;
}

/** A template prefix's files, as the run's config names them: the one
 *  edited file a merge launch sets, or the list a category's field holds. */
const FILE_CATEGORIES: Record<
  FileCategoryPrefix | 'MEDIA',
  (config: AgentConfig) => readonly (string | null)[]
> = {
  INPUT: (config) => config.inputFiles,
  CONTEXT: (config) => config.contextFiles,
  MEDIA: (config) => config.mediaFiles,
  EDITED: (config) => [config.editedFile],
};

/** A category's files, empties dropped and each named once. */
function getCategoryFiles(
  config: AgentConfig,
  category: FileCategoryPrefix | 'MEDIA',
): string[] {
  const files = FILE_CATEGORIES[category](config).filter(
    (file): file is string => typeof file === 'string' && file.trim() !== '',
  );
  return [...new Set(files)];
}

/** Categories used for building file vars (excludes MEDIA which is display-only) */
type FileCategoryPrefix = 'INPUT' | 'CONTEXT' | 'EDITED';
const FILE_VAR_CATEGORIES: readonly FileCategoryPrefix[] = [
  'INPUT',
  'CONTEXT',
  'EDITED',
];

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
type FileVars = FileCategoryVars & Pick<TemplateInputs, 'MEDIA_FILE'>;

const getFileVars = Effect.fn('userVars.getFileVars')(function* (
  agentConfig: AgentConfig,
  logger: AgentTrace,
  workspaceRoot: string | undefined,
): Effect.fn.Return<FileVars, never, FileSystem.FileSystem> {
  // Compiler-checked completeness: every FileVars key starts at its
  // empty-file default here, so a future FileVars key without a matching
  // default is a type error at this literal. The loop below only overwrites
  // the defaults, and an unreadable file leaves the null pair standing.
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
    const { xml, readable, skipped } =
      allFiles.length > 0
        ? yield* getXmlFormatFromReadableFiles(workspaceRoot, allFiles)
        : { xml: null, readable: [], skipped: [] };
    const readableFiles = readable.map(({ file }) => file);
    // The first readable file fills the `*_FILE`/`*_CONTENT` pair from the
    // same read that built the list vars.
    const primary = readable[0];
    if (primary != null) {
      userVars[`${prefix}_FILE`] = primary.file;
      userVars[`${prefix}_CONTENT`] = primary.content;
    }

    // A dropped file changes what the model sees, so report it on the run's own
    // channel rather than leaving it on a module logger nobody reads.
    for (const { file, reason } of skipped) {
      logger.warn(
        `Skipping unreadable file in prompt context: ${file} (${reason})`,
      );
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

  userVars.MEDIA_FILE = getCategoryFiles(agentConfig, 'MEDIA')[0] ?? null;

  return userVars;
});

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

    const parts = results
      .map((result) => result.xml)
      .filter(Predicate.isNotNull);
    const misses = results
      .map((result) => result.miss)
      .filter(Predicate.isNotNull);
    return {
      xml:
        parts.length > 0
          ? `<attached_memories>\n${parts.join('\n')}\n</attached_memories>`
          : null,
      misses,
    };
  },
);
