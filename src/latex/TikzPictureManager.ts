// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem } from 'effect';

// Local imports - log
import { withLogChannel } from '@logger/effectLog';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type { FileLocation } from '@shared/schemas';
import { renderPrompt } from '@utils/prompt';
import { pathToLocationIn } from '@utils/files/fileLocation';
import { normalizeLineEndings } from '@utils/text/stringUtils';

// Local imports - latex utils
import { compileLatex2Pdf } from './texTools';
import { LATEX_COMMANDS_CHANNEL as CHANNEL } from './latexLogging';

/**
 * Create a standalone LaTeX file for a TikZ picture
 * @param template The `texra.latex.tikzTemplate` the picture is rendered into
 * @param tikzpictures TikZ picture content
 * @param label Label for the figure
 * @param buildDir Absolute build directory path
 * @param workspaceRoot The session's workspace root the file is located in
 * @param suffix Optional suffix for multiple pictures with same label
 * @returns FileLocation of created LaTeX file
 */
const createStandalone = Effect.fn('TikzPictureManager.createStandalone')(
  function* (
    template: string,
    tikzpictures: string,
    label: string,
    buildDir: string,
    workspaceRoot: string | undefined,
    suffix?: string,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const standaloneContent = yield* renderPrompt(template, {
      tikzpicture: tikzpictures,
    });

    const filename = suffix ? `${label}_${suffix}.tex` : `${label}.tex`;
    const texLocation = pathToLocationIn(
      workspaceRoot,
      path.join(buildDir, filename),
    );

    yield* fs.writeFileString(texLocation.absolutePath, standaloneContent);
    yield* Effect.logDebug(
      `Created standalone LaTeX file: ${texLocation.absolutePath}`,
    ).pipe(withLogChannel(CHANNEL));

    return texLocation;
  },
);

/**
 * Extract TikZ pictures with their labels from a LaTeX file
 * @param latexFile FileLocation of the LaTeX file
 * @returns Array of [label, tikzpictures] tuples
 */
const extract = Effect.fn('TikzPictureManager.extract')(function* (
  latexFile: FileLocation,
) {
  const fs = yield* FileSystem.FileSystem;
  const content = normalizeLineEndings(
    yield* fs.readFileString(latexFile.absolutePath),
  );

  // Match each figure block first, then inspect labels inside the block. This
  // prevents an unlabeled figure from consuming a later figure's label.
  const figurePattern =
    /\\begin\{(figure\*?)\}(?:\[[^\]]*\])?([\s\S]*?)\\end\{\1\}/g;
  const labelPattern = /\\label\{([^}]*)\}/;
  const tikzPattern = /\\begin{tikzpicture}.*?\\end{tikzpicture}/gs;

  const labeledTikzPictures: [string, string[]][] = [];

  for (const figureMatch of content.matchAll(figurePattern)) {
    const figureContent = figureMatch[2];
    const label = labelPattern.exec(figureContent)?.[1];
    if (!label) {
      continue;
    }

    // Find all tikzpictures in this figure
    const tikzMatches = [...figureContent.matchAll(tikzPattern)].map(
      (match) => match[0],
    );

    if (tikzMatches.length > 0) {
      labeledTikzPictures.push([label, tikzMatches]);
      yield* Effect.logDebug(`Found TikZ picture with label: ${label}`).pipe(
        withLogChannel(CHANNEL),
      );
    }
  }

  return labeledTikzPictures;
});

/**
 * Extract and compile TikZ pictures from a LaTeX file
 * @param latexFile Location of the LaTeX file
 * @param roots The session's roots: the TikZ template and the compile's LaTeX
 *   settings come from its configuration, and the products are located in its
 *   workspace
 * @returns Array of FileLocations for compiled PDF files
 */
const compile = Effect.fn('TikzPictureManager.compile')(function* (
  latexFile: FileLocation,
  roots: WorkspaceRoots,
) {
  const fs = yield* FileSystem.FileSystem;
  const inputName = path.parse(latexFile.absolutePath).name;
  const buildDir = path.join(
    path.dirname(latexFile.absolutePath),
    'build',
    inputName,
  );

  yield* fs.makeDirectory(buildDir, { recursive: true });

  yield* Effect.logDebug(
    `Extracting TikZ pictures from ${latexFile.absolutePath}`,
  ).pipe(withLogChannel(CHANNEL));
  const labeledTikzPictures = yield* extract(latexFile);
  yield* Effect.logDebug(
    `Found ${labeledTikzPictures.length} labeled TikZ pictures`,
  ).pipe(withLogChannel(CHANNEL));

  const template = roots.config.get<string>('texra.latex.tikzTemplate');
  const compiledFiles: FileLocation[] = [];

  for (const [label, tikzPictures] of labeledTikzPictures) {
    const hasMultiple = tikzPictures.length > 1;

    for (const [i, tikzpictures] of tikzPictures.entries()) {
      // Disambiguate multiple pictures under one label with a/b/c… suffixes.
      const suffix = hasMultiple ? String.fromCharCode(97 + i) : undefined;

      const texLocation = yield* createStandalone(
        template,
        tikzpictures,
        label,
        buildDir,
        roots.workspace,
        suffix,
      );
      const compiled = yield* compileLatex2Pdf(texLocation, roots, {
        channel: CHANNEL,
        compiler: 'pdflatex',
      });
      if (!compiled.ok) {
        yield* Effect.logWarning(
          `Failed to compile TikZ picture ${texLocation.absolutePath}:\n${compiled.logTail}`,
        ).pipe(
          Effect.annotateLogs({
            data: {
              texFile: texLocation.absolutePath,
              logTail: compiled.logTail,
            },
          }),
          withLogChannel(CHANNEL),
        );
      }

      // Derive PDF location from tex location
      const pdfLocation = pathToLocationIn(
        roots.workspace,
        texLocation.absolutePath.replace(/\.tex$/, '.pdf'),
      );

      if (yield* fs.exists(pdfLocation.absolutePath)) {
        compiledFiles.push(pdfLocation);
        yield* Effect.logDebug(
          `Successfully compiled: ${pdfLocation.absolutePath}`,
        ).pipe(withLogChannel(CHANNEL));
      }
    }
  }

  return compiledFiles;
});

/**
 * TikZ picture extraction and compilation, exported as a stateless module of
 * Effect functions (no class state or lifecycle).
 */
export const TikzPictureManager = { extract, compile };
