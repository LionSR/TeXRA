import * as path from 'node:path';

import { Effect, FileSystem } from 'effect';

import { parseFrontmatter } from '@agent/memory/memoryMeta';
import { displayToStoragePath } from '@agent/memory/memoryLayout';
import {
  runsScript,
  type AgentConfig,
  type AttachedMemoryMiss,
} from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { readNormalizedFile } from '@utils/files/fsDurability';

/**
 * The variables a run's system text (and the harness's own tool-use suffix)
 * may read, rendered once at launch. Nothing persists them: a run records
 * the text it rendered, and what follows the step (the tool-call mechanics,
 * the skills) is rendered per request (`stepInstructions`).
 */
interface PromptVariables {
  /** Working directory the run's tools operate in. */
  CWD: string;
}

/**
 * The roots of the session this run belongs to, held as data, so a run never
 * reads whichever roots the calling fiber carries. Tools use the working
 * directory (else the workspace), and attached memories live in storage.
 */
interface BuildTemplateInputsOptions {
  workspaceRoot: string | undefined;
  workingDirectory?: string;
  storageRoot: string;
}

type AttachedMemoriesResult = {
  xml: string | null;
  misses: AttachedMemoryMiss[];
};

/**
 * What a launch opens from: the prompt variables; the names of the skills a
 * tool-use run's user activated with its launch; the attached memories' XML block,
 * appended to the system prompt (null when none are attached); and the
 * attached memories that could not be read.
 */
export interface TemplateOpening {
  readonly inputs: Readonly<PromptVariables>;
  readonly activated: readonly string[];
  readonly attachedMemories: string | null;
  readonly attachedMemoryMisses: AttachedMemoryMiss[];
}

/**
 * Build what a launch renders its prompts from.
 *
 * @param options.workspaceRoot - Workspace root of the run's session.
 */
export const buildTemplateInputs = Effect.fn('buildTemplateInputs')(function* (
  agentConfig: AgentConfig,
  options: BuildTemplateInputsOptions,
): Effect.fn.Return<TemplateOpening, never, FileSystem.FileSystem> {
  const attachedMemories = yield* getAttachedMemories(
    agentConfig.memories,
    options.storageRoot,
  );
  const inputs: PromptVariables = {
    CWD: options.workingDirectory ?? options.workspaceRoot ?? '.',
  };

  return {
    inputs,
    // What the launch activates (`/skills`): each step resolves the names
    // against its own catalog; a script's run, which renders no prompt,
    // none.
    activated: runsScript(agentConfig) ? [] : (agentConfig.skills ?? []),
    attachedMemories: attachedMemories.xml,
    attachedMemoryMisses: attachedMemories.misses,
  };
});

/**
 * Load attached memory files and format them as an XML block for prompt injection.
 * Memory paths are display paths (e.g. /memories/conventions.md).
 * Returns null if no memories are attached.
 */
const getAttachedMemories = Effect.fn('userVars.getAttachedMemories')(
  function* (
    memoryPaths: readonly string[],
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
        Effect.fromResult(displayToStoragePath(displayPath)).pipe(
          Effect.flatMap((storagePath) =>
            readNormalizedFile(fs, path.join(storageRoot, storagePath)),
          ),
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

    const parts = results.flatMap((result) => result.xml ?? []);
    const misses = results.flatMap((result) => result.miss ?? []);
    return {
      xml:
        parts.length > 0
          ? `<attached_memories>\n${parts.join('\n')}\n</attached_memories>`
          : null,
      misses,
    };
  },
);
