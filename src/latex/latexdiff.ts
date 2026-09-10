import * as path from 'node:path';

import { Effect } from 'effect';

import { formatError, isFileNotFoundError } from '@common/errors';
import { withLogChannel } from '@logger/effectLog';
import type { FileLocation } from '@shared/schemas';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { ensureError } from '@utils/errors/errorMessage';
import { pathToLocation } from '@utils/files/fileLocation';
import { executeCommand } from '@utils/system/execUtils';
import {
  buildBetweenRoundDiffSuffix,
  generateDiffFileName,
} from './latexdiff/diffFileNameManager';
import { DiffFileProcessor } from './latexdiff/diffFileProcessor';
import { DiffCommandExecutor } from './latexdiff/diffCommandExecutor';
import type { MathMarkupOption } from './latexdiff/mathMarkup';

export type LaTeXdiffResult =
  | {
      success: true;
      /**
       * Absolute path of the generated diff `.tex`. The service picks the
       * output directory (an `outputDirectory` option, the input's folder,
       * or the git root for `runDiffVc`), so only it can name the file —
       * consumers must not re-join a bare filename against a directory of
       * their own guessing.
       */
      diffPath: string;
      message: string;
    }
  | {
      success: false;
      message: string;
    };

/** A failed diff, as the value every entry point resolves to. */
function failed(message: string): LaTeXdiffResult {
  return { success: false, message };
}

function succeeded(diffPath: string, message: string): LaTeXdiffResult {
  return { success: true, diffPath, message };
}

function hasDocumentEnvironment(content: string): boolean {
  return (
    content.includes('\\begin{document}') && content.includes('\\end{document}')
  );
}

export class LaTeXdiffService {
  private readonly fileProcessor: DiffFileProcessor;
  private readonly commandExecutor: DiffCommandExecutor;

  constructor(private readonly channel: string) {
    this.fileProcessor = new DiffFileProcessor();
    this.commandExecutor = new DiffCommandExecutor(channel);
  }

  /**
   * Turn a diff failure into the service's own result value. Every public
   * entry point ends here, so a caller never has to distinguish "latexdiff
   * refused" from "the run threw".
   */
  private failure(
    context: string,
  ): (err: unknown) => Effect.Effect<LaTeXdiffResult> {
    return (err) =>
      Effect.suspend(() => {
        const message = formatError(context, err);
        return Effect.logError(message).pipe(Effect.as(failed(message)));
      });
  }

  private read(absolutePath: string): Effect.Effect<string, Error> {
    return Effect.tryPromise({
      try: () => AbsoluteFS.read(absolutePath),
      catch: ensureError,
    });
  }

  /** Read both diff inputs, returning null when either input no longer exists. */
  private readDiffInputs(
    inputLocation: FileLocation,
    editedLocation: FileLocation,
  ): Effect.Effect<[string, string] | null, Error> {
    return Effect.all(
      [
        this.read(inputLocation.absolutePath),
        this.read(editedLocation.absolutePath),
      ],
      { concurrency: 2 },
    ).pipe(
      Effect.catchIf(isFileNotFoundError, () =>
        Effect.succeed<[string, string] | null>(null),
      ),
    );
  }

  runDiff(
    inputLocation: FileLocation,
    editedLocation: FileLocation,
    suffix = '_diff',
    mathMarkup?: MathMarkupOption,
    options?: { cwd?: string; subtype?: string; outputDirectory?: string },
  ): Effect.Effect<LaTeXdiffResult> {
    return Effect.gen({ self: this }, function* () {
      const inputFile = inputLocation.absolutePath;
      const editedFile = editedLocation.absolutePath;

      if (!inputFile) {
        yield* Effect.logWarning('Input file is empty or undefined');
        return failed('Input file is empty or undefined');
      }

      // Direct callers use one read pass for both existence and document
      // structure validation. Round-specific wrappers keep their earlier
      // exists checks so they can report round-specific error messages.
      const contents = yield* this.readDiffInputs(
        inputLocation,
        editedLocation,
      );
      if (!contents) {
        const message = `One or both files do not exist. Input: ${inputFile}, Edited: ${editedFile}`;
        yield* Effect.logWarning(message);
        return failed(message);
      }
      if (!contents.every(hasDocumentEnvironment)) {
        return failed('Files missing document environment');
      }

      const diffFileName = generateDiffFileName(inputFile, editedFile, suffix);
      const outputDirectory =
        options?.outputDirectory ?? path.dirname(inputFile);
      const outputPath = path.join(outputDirectory, diffFileName);

      yield* Effect.logDebug(
        `Running latexdiff for ${inputLocation.absolutePath} and ${editedLocation.absolutePath}`,
      );

      const result = yield* this.commandExecutor.executeDiff(
        inputFile,
        editedFile,
        { mathMarkup, subtype: options?.subtype, cwd: options?.cwd },
      );
      if (!result.stdout) {
        return yield* Effect.fail(new Error('Latexdiff produced no output'));
      }

      // Write and process output
      const outputLocation = pathToLocation(outputPath);
      yield* Effect.tryPromise({
        try: async () => {
          await AbsoluteFS.ensureDir(outputDirectory);
          await AbsoluteFS.write(outputLocation.absolutePath, result.stdout);
        },
        catch: ensureError,
      });
      yield* this.fileProcessor.processDiffFile(outputLocation, editedLocation);

      yield* Effect.logDebug(
        `Latexdiff succeeded: ${inputLocation.absolutePath} -> ${editedLocation.absolutePath}`,
      );

      return succeeded(
        outputLocation.absolutePath,
        `LaTeXdiff completed successfully: ${diffFileName}`,
      );
    }).pipe(
      Effect.tapError(() =>
        Effect.logDebug(
          `Latexdiff failed: ${inputLocation.absolutePath} -> ${editedLocation.absolutePath}`,
        ),
      ),
      Effect.catch(this.failure('Error running LaTeX diff')),
      withLogChannel(this.channel),
    );
  }

  runDiffVc(
    inputLocation: FileLocation,
    commitHash: string,
    mathMarkup?: MathMarkupOption,
  ): Effect.Effect<LaTeXdiffResult> {
    return Effect.gen({ self: this }, function* () {
      const inputFile = inputLocation.absolutePath;
      if (!hasDocumentEnvironment(yield* this.read(inputFile))) {
        const message =
          'File missing document environment (must contain \\begin{document} and \\end{document})';
        yield* Effect.logError(message);
        return failed(message);
      }

      // latexdiff-vc --git runs `git show <commit>:<file>`, which expects
      // a path relative to the repo root. Absolute paths break its temp
      // path construction. Resolve via git rev-parse to get the repo root.
      const fileDir = path.dirname(inputFile);
      const gitRoot = yield* this.getGitRoot(fileDir);
      const cwd = gitRoot ?? fileDir;
      const filePath = gitRoot
        ? path.relative(gitRoot, inputFile)
        : path.basename(inputFile);

      yield* this.commandExecutor.executeDiffVc(filePath, commitHash, {
        mathMarkup,
        cwd,
      });

      // latexdiff-vc writes output alongside the input, relative to cwd,
      // inserting `-diff<hash>` before the extension. Anchor the insertion to
      // the parsed extension: a plain `.tex` string replacement would land on
      // the first literal `.tex` anywhere in the path, so a directory such as
      // `my.texnotes/` would send us looking for a file that was never written.
      const parsedFilePath = path.parse(filePath);
      const diffFilePath = path.join(
        parsedFilePath.dir,
        `${parsedFilePath.name}-diff${commitHash}${parsedFilePath.ext}`,
      );
      const outputPath = path.join(cwd, diffFilePath);
      yield* this.fileProcessor.processDiffFile(
        pathToLocation(outputPath),
        inputLocation,
      );

      const diffFileName = path.basename(diffFilePath);

      return succeeded(
        outputPath,
        `LaTeXdiff VC completed successfully: ${diffFileName}`,
      );
    }).pipe(
      Effect.catch(this.failure('Error running LaTeX diff VC')),
      withLogChannel(this.channel),
    );
  }

  runDiffForRound(
    baseLocation: FileLocation,
    outputLocation: FileLocation,
    round: number,
    mathMarkup?: MathMarkupOption,
    options?: { cwd?: string; outputDirectory?: string },
  ): Effect.Effect<LaTeXdiffResult> {
    return Effect.gen({ self: this }, function* () {
      if (!(yield* this.bothFilesExist(baseLocation, outputLocation))) {
        const message = `Could not generate latexdiff for round ${round}. Files not found: ${baseLocation.absolutePath} or ${outputLocation.absolutePath}`;
        yield* Effect.logWarning(message);
        return failed(message);
      }

      return yield* this.runDiff(
        baseLocation,
        outputLocation,
        '_diff',
        mathMarkup,
        options,
      );
    }).pipe(
      Effect.catch(this.failure('Error in runDiffForRound')),
      withLogChannel(this.channel),
    );
  }

  runDiffBetweenRounds(
    firstLocation: FileLocation,
    secondLocation: FileLocation,
    fromRound: number,
    toRound: number,
    mathMarkup?: MathMarkupOption,
    options?: { cwd?: string; outputDirectory?: string },
  ): Effect.Effect<LaTeXdiffResult> {
    return Effect.gen({ self: this }, function* () {
      if (!(yield* this.bothFilesExist(firstLocation, secondLocation))) {
        const message = `Could not generate latexdiff between rounds. Files not found: ${firstLocation.absolutePath} or ${secondLocation.absolutePath}`;
        yield* Effect.logWarning(message);
        return failed(message);
      }

      const diffSuffix = buildBetweenRoundDiffSuffix(toRound, fromRound);
      return yield* this.runDiff(
        firstLocation,
        secondLocation,
        diffSuffix,
        mathMarkup,
        options,
      );
    }).pipe(
      Effect.catch(this.failure('Error in runDiffBetweenRounds')),
      withLogChannel(this.channel),
    );
  }

  private bothFilesExist(
    first: FileLocation,
    second: FileLocation,
  ): Effect.Effect<boolean, Error> {
    const exists = (location: FileLocation) =>
      Effect.tryPromise({
        try: () => AbsoluteFS.exists(location.absolutePath),
        catch: ensureError,
      });
    return Effect.all([exists(first), exists(second)], {
      concurrency: 2,
    }).pipe(Effect.map(([a, b]) => a && b));
  }

  private getGitRoot(cwd: string): Effect.Effect<string | null, Error> {
    return Effect.tryPromise({
      try: (signal) =>
        executeCommand(['git', 'rev-parse', '--show-toplevel'], {
          channel: this.channel,
          cwd,
          signal,
        }),
      catch: ensureError,
    }).pipe(
      Effect.map((result) =>
        result.success && result.stdout ? result.stdout.trim() : null,
      ),
    );
  }
}
