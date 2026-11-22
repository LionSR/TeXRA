// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem } from 'effect';

// Local imports - log
import {
  renderPrompt,
  withLogChannel,
  Settings,
  type SettingsStores,
  WorkspaceFs,
  pathToLocationIn,
} from '@texra-ai/worldline/plugins';

// Local imports - latex utils
import { readUncommentedLatex } from './latexParsingUtils';
import { compileLatex2Pdf, perInputBuildDirectory } from './texTools';
import { LATEX_COMMANDS_CHANNEL as CHANNEL } from './latexLogging';
import type { FileLocation } from '@texra-ai/worldline/schemas';
import { TIKZ_TEMPLATE_SETTING } from '@texra/shared/settings/texraSettings';

/**
 * Create a standalone LaTeX file for a TikZ picture
 * @param template The `texra.latex.tikzTemplate` the picture is rendered into
 * @param buildDir Absolute build directory path
 * @param workspaceRoot The session's workspace root the file is located in
 * @param suffix Optional suffix for multiple pictures with same label
 * @returns FileLocation of created LaTeX file
 */
const createStandalone = Effect.fn('tikzPictures.createStandalone')(function* (
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
});

/**
 * Extract TikZ pictures with their labels from a LaTeX file
 * @returns Array of [label, tikzpictures] tuples
 */
export const extractTikzPictures = Effect.fn('tikzPictures.extract')(function* (
  latexFile: FileLocation,
) {
  // A commented-out figure is not compiled.
  const content = yield* readUncommentedLatex(latexFile.absolutePath);

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
 * Compile the TikZ pictures {@link extractTikzPictures} found in a LaTeX file
 * @param latexFile Location of the LaTeX file
 * @param labeledTikzPictures What {@link extractTikzPictures} returned for it
 * @param stores The session's setting slots: the TikZ template and the
 *   compile's LaTeX settings. The products are located in the workspace of
 *   the {@link WorkspaceFs} in context.
 * @returns Array of FileLocations for compiled PDF files
 */
export const compileTikzPictures = Effect.fn('tikzPictures.compile')(function* (
  latexFile: FileLocation,
  labeledTikzPictures: readonly (readonly [string, readonly string[]])[],
  stores: SettingsStores,
) {
  const fs = yield* FileSystem.FileSystem;
  const workspaceRoot = (yield* WorkspaceFs).root;
  const buildDir = perInputBuildDirectory(latexFile.absolutePath);

  yield* fs.makeDirectory(buildDir, { recursive: true });

  const template = yield* Settings.get(stores, TIKZ_TEMPLATE_SETTING);
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
        workspaceRoot,
        suffix,
      );
      const compiled = yield* compileLatex2Pdf(texLocation, stores, {
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
        continue;
      }
      compiledFiles.push(pathToLocationIn(workspaceRoot, compiled.pdfPath));
      yield* Effect.logDebug(`Successfully compiled: ${compiled.pdfPath}`).pipe(
        withLogChannel(CHANNEL),
      );
    }
  }

  return compiledFiles;
});
