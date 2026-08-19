// Standard library imports
import * as path from 'node:path';
import { promises as fs } from 'node:fs';

import { isFileNotFoundError } from '@common/errors';
import { createLog } from '@logger/logUtils';
import { type ExecutionId, type FileLocation } from '@shared/schemas';
import {
  WORKFLOW_OUTPUT_BASENAME,
  workflowOutputRoundDir,
} from '@shared/constants/workflowOutput';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  createExternalLocation,
  createRunStorageLocation,
  pathToLocation,
} from './fileLocation';
import {
  CHANNEL,
  createSymlink,
  ensureParentDir,
  ensureRunDir,
  getRunDir,
  getOriginalSnapshotPath,
  getRunStorageAbsolutePath,
  runStorageLocationFromAnyAbsolutePath,
  shouldSkipRelocation,
  snapshotExists,
} from './runStorageFs';
import { WorkspaceFS } from './workspaceFS';

const log = createLog(CHANNEL);

export class TaskRunFileService {
  public readonly runDirectory: string;
  private hasPreparedSnapshot = false;
  private readonly mirroredDependencies = new Set<string>();

  constructor(public readonly executionId: ExecutionId) {
    this.runDirectory = getRunDir(executionId);
  }

  /**
   * Prepare run storage before processing begins by capturing the original
   * versions of the selected base files and mirroring any declared dependencies.
   *
   * Base files are copied into `executions/<id>/original/` as immutable snapshots
   * so the workspace can be restored even after the agent edits files in-place.
   * Additional workspace dependencies (references, auxiliaries, extracted
   * figures, etc.) are mirrored into the active run directory via symlinks so
   * tools operating inside task-run storage can resolve them using their
   * familiar workspace-relative paths.
   */
  public async prepareRunWorkspace(
    baseFiles: FileLocation[],
    options: {
      linkFiles?: FileLocation[];
    } = {},
  ): Promise<void> {
    if (this.hasPreparedSnapshot) return;

    await ensureRunDir(this.executionId);

    const linkTargets = new Set<FileLocation>(baseFiles);

    // Add extra link files, filtering out any null/undefined entries
    for (const extra of options.linkFiles ?? []) {
      if (extra) linkTargets.add(extra);
    }

    await Promise.all(
      baseFiles.map((target) => this.captureOriginalSnapshot(target)),
    );

    await Promise.all(
      [...linkTargets].map(async (candidate) => {
        try {
          await this.mirrorWorkspaceFile(candidate);
        } catch (error) {
          log.warn(
            `Failed to mirror workspace dependency ${candidate.absolutePath}: ${toErrorMessage(error)}`,
          );
        }
      }),
    );

    this.hasPreparedSnapshot = true;
  }

  /**
   * Copy a workspace file into `original/<relativePath>` if not already captured.
   * Round-dir symlinks point here rather than the live workspace so an agent
   * write at `r<N>/<relPath>` can never reach the user's working copy.
   * Idempotent; skips non-workspace, ignored-root, non-regular, and missing sources.
   */
  private async captureOriginalSnapshot(target: FileLocation): Promise<void> {
    if (target.kind !== 'workspace') return;
    if (shouldSkipRelocation(target.relativePath)) return;

    try {
      const stats = await fs.stat(target.absolutePath);
      if (!stats.isFile()) return;

      const snapshotAbsolute = getOriginalSnapshotPath(
        this.executionId,
        target.relativePath,
      );

      if (await snapshotExists(snapshotAbsolute)) return;

      await ensureParentDir(snapshotAbsolute);
      await fs.copyFile(target.absolutePath, snapshotAbsolute);
    } catch (error) {
      if (isFileNotFoundError(error)) return;
      throw new Error(
        `Failed to capture original file ${target.absolutePath}: ${toErrorMessage(error)}`,
        { cause: error },
      );
    }
  }

  /** Create a FileLocation for a workflow output file. */
  public createLocation(inputPath: string): FileLocation {
    const runStorageLocation = runStorageLocationFromAnyAbsolutePath(inputPath);
    if (runStorageLocation) return runStorageLocation;

    const resolved = WorkspaceFS.locatePath(inputPath);

    if (resolved.kind === 'external') {
      return createExternalLocation(resolved.absolutePath);
    }

    const runAbsolute = getRunStorageAbsolutePath(
      this.executionId,
      resolved.relativePath,
    );
    return createRunStorageLocation(
      runAbsolute,
      resolved.relativePath,
      this.executionId,
    );
  }

  /** Preserve the storage provenance of an existing input or comparison base. */
  public locateSource(inputPath: string): FileLocation {
    return (
      runStorageLocationFromAnyAbsolutePath(inputPath) ??
      pathToLocation(inputPath)
    );
  }

  /**
   * Ensure a workspace dependency is reachable from run storage via symlink.
   * Takes a FileLocation and creates a symlink in run storage if needed.
   *
   * Pass `snapshot: true` for editable inputs so the file is also copied into
   * `original/<relPath>`; round-dir symlinks then point there rather than
   * chaining back to the live workspace.
   */
  public async mirrorWorkspaceFile(
    location: FileLocation,
    options: { snapshot?: boolean } = {},
  ): Promise<FileLocation> {
    if (
      location.kind !== 'workspace' ||
      shouldSkipRelocation(location.relativePath)
    ) {
      return location;
    }

    await ensureRunDir(this.executionId);
    const runAbsolute = getRunStorageAbsolutePath(
      this.executionId,
      location.relativePath,
    );

    if (!this.mirroredDependencies.has(location.relativePath)) {
      await createSymlink(location.absolutePath, runAbsolute);
      this.mirroredDependencies.add(location.relativePath);
    }

    if (options.snapshot) {
      await this.captureOriginalSnapshot(location);
    }

    return createRunStorageLocation(
      runAbsolute,
      location.relativePath,
      this.executionId,
    );
  }

  /**
   * For every mirrored top-level dependency, ensure a symlink also exists at
   * `<runDir>/r{round}/<relativePath>`. This lets `latexmk`, `pdflatex`, and
   * `latexdiff` run with `cwd = runDir/r{round}` and resolve `\input{foo}`
   * against sibling symlinks. Idempotent; safe to call every round.
   *
   * Collisions with primary workflow artifacts are skipped:
   *   - `output.{ext}` at runDir root (the fixed round-output basename from
   *     `WORKFLOW_OUTPUT_BASENAME`).
   *   - Any existing real file at the destination — e.g. an extracted
   *     multi-document output written to `r{round}/<source>.tex` by the
   *     XML output manager when the same path is also an `\input`
   *     dependency. Replacing that real file with a symlink to the
   *     original workspace source would silently destroy the round's
   *     revised content.
   */
  public async ensureMirroredInRoundDir(round: number): Promise<void> {
    await this.ensureMirroredInRunSubdir(workflowOutputRoundDir(round), {
      protectPrimaryOutput: true,
    });
  }

  /**
   * Ensure mirrored workspace dependencies are also reachable from
   * `<runDir>/diff/r{round}/...`, where workflow latexdiff sources and build
   * artifacts live.
   */
  public async ensureMirroredInDiffRoundDir(round: number): Promise<void> {
    await this.ensureMirroredInRunSubdir(
      path.join('diff', workflowOutputRoundDir(round)),
      { protectPrimaryOutput: false },
    );
  }

  private async ensureMirroredInRunSubdir(
    relativeDirectory: string,
    options: { protectPrimaryOutput: boolean },
  ): Promise<void> {
    if (this.mirroredDependencies.size === 0) return;

    await Promise.all(
      [...this.mirroredDependencies].map(async (relativePath) => {
        // A dep whose path ends at `output.{ext}` (no subdirectory within the
        // round) would symlink over the primary revised output that lives at
        // `r{round}/output.{ext}`. `createSymlink` replaces any existing
        // entry on EEXIST, so an unguarded mirror would silently destroy the
        // round's result. Skip these — the dependency is still reachable at
        // `r{round}/../<relativePath>`, i.e. `<runDir>/<relativePath>`.
        const { dir: depDir, name: depName } = path.parse(relativePath);
        if (
          options.protectPrimaryOutput &&
          depDir === '' &&
          depName === WORKFLOW_OUTPUT_BASENAME
        ) {
          log.debug(
            `Skipping run-dir mirror of ${relativePath}: would clobber primary output in ${relativeDirectory}`,
          );
          return;
        }

        // Prefer the immutable `original/` snapshot as the symlink source
        // for editable inputs, so the chain `r<N>/<rel> → original/<rel>`
        // never reaches the live workspace. Read-only build assets
        // (cls/sty/bib/figures) have no snapshot and fall through to the
        // workspace mirror at `runDir/<rel>`, which is correct — those
        // are never written to.
        const snapshotAbsolute = getOriginalSnapshotPath(
          this.executionId,
          relativePath,
        );
        const workspaceMirrorAbsolute = getRunStorageAbsolutePath(
          this.executionId,
          relativePath,
        );
        let sourceAbsolute = workspaceMirrorAbsolute;
        try {
          await fs.stat(snapshotAbsolute);
          sourceAbsolute = snapshotAbsolute;
        } catch (error) {
          if (!isFileNotFoundError(error)) {
            log.debug(
              `Unable to stat snapshot ${snapshotAbsolute}: ${toErrorMessage(error)}`,
            );
          }
        }
        const destinationAbsolute = getRunStorageAbsolutePath(
          this.executionId,
          path.join(relativeDirectory, relativePath),
        );

        // Guard against clobbering a real file already written to the round
        // dir — e.g. a multi-document extracted output at
        // `r{round}/chapters/ch1.tex` when `chapters/ch1.tex` is also an
        // `\input` dependency. A stale symlink from a previous call is
        // safe to replace (idempotent); anything else must be preserved.
        try {
          const stat = await fs.lstat(destinationAbsolute);
          if (!stat.isSymbolicLink()) {
            log.debug(
              `Skipping run-dir mirror of ${relativePath}: destination in ${relativeDirectory} is an existing real file`,
            );
            return;
          }
        } catch (error) {
          if (!isFileNotFoundError(error)) {
            log.debug(
              `Unable to stat ${destinationAbsolute}: ${toErrorMessage(error)}`,
            );
          }
          // ENOENT is the common case — no collision, proceed with the link.
        }

        try {
          await createSymlink(sourceAbsolute, destinationAbsolute);
        } catch (error) {
          log.debug(
            `Unable to mirror ${relativePath} into ${relativeDirectory}: ${toErrorMessage(error)}`,
          );
        }
      }),
    );
  }
}
