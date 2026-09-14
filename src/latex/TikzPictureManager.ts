// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem } from 'effect';

// Local imports - log
import { createLog } from '@logger/logUtils';
import type { ConfigProvider } from '@platform/interfaces';
import type { FileLocation } from '@shared/schemas';
import { renderPrompt } from '@utils/prompt';
import { readConfig } from '@utils/config/configUtils';
import { ensureError } from '@utils/errors/errorMessage';
import { pathToLocation } from '@utils/files/fileLocation';
import { normalizeLineEndings } from '@utils/text/stringUtils';

// Local imports - latex utils
import { compileLatex2Pdf } from './texTools';
import { LATEX_COMMANDS_CHANNEL as CHANNEL } from './latexLogging';

const log = createLog(CHANNEL);

/**
 * Create a standalone LaTeX file for a TikZ picture
 * @param template The `texra.latex.tikzTemplate` the picture is rendered into
 * @param tikzpictures TikZ picture content
 * @param label Label for the figure
 * @param buildDir Absolute build directory path
 * @param suffix Optional suffix for multiple pictures with same label
 * @returns FileLocation of created LaTeX file
 */
const createStandalone = Effect.fn('TikzPictureManager.createStandalone')(
  function* (
    template: string,
    tikzpictures: string,
    label: string,
    buildDir: string,
    suffix?: string,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const standaloneContent = yield* Effect.tryPromise({
      try: () => renderPrompt(template, { tikzpicture: tikzpictures }),
      catch: ensureError,
    });

    const filename = suffix ? `${label}_${suffix}.tex` : `${label}.tex`;
    const texLocation = pathToLocation(path.join(buildDir, filename));

    yield* fs.writeFileString(texLocation.absolutePath, standaloneContent);
    log.debug(`Created standalone LaTeX file: ${texLocation.absolutePath}`);

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
      log.debug(`Found TikZ picture with label: ${label}`);
    }
  }

  return labeledTikzPictures;
});

/**
 * Extract and compile TikZ pictures from a LaTeX file
 * @param latexFile Location of the LaTeX file
 * @param config The session's configuration: the TikZ template and the
 *   compile's LaTeX settings
 * @returns Array of FileLocations for compiled PDF files
 */
const compile = Effect.fn('TikzPictureManager.compile')(function* (
  latexFile: FileLocation,
  config: ConfigProvider,
) {
  const fs = yield* FileSystem.FileSystem;
  const inputName = path.parse(latexFile.absolutePath).name;
  const buildDir = path.join(
    path.dirname(latexFile.absolutePath),
    'build',
    inputName,
  );

  yield* fs.makeDirectory(buildDir, { recursive: true });

  log.debug(`Extracting TikZ pictures from ${latexFile.absolutePath}`);
  const labeledTikzPictures = yield* extract(latexFile);
  log.debug(`Found ${labeledTikzPictures.length} labeled TikZ pictures`);

  const template = readConfig<string>(config, 'texra.latex.tikzTemplate');
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
        suffix,
      );
      const compiled = yield* compileLatex2Pdf(texLocation, config, {
        channel: CHANNEL,
        compiler: 'pdflatex',
      });
      if (!compiled.ok) {
        log.warn(
          `Failed to compile TikZ picture ${texLocation.absolutePath}:\n${compiled.logTail}`,
          {
            data: {
              texFile: texLocation.absolutePath,
              logTail: compiled.logTail,
            },
          },
        );
      }

      // Derive PDF location from tex location
      const pdfLocation = pathToLocation(
        texLocation.absolutePath.replace(/\.tex$/, '.pdf'),
      );

      if (yield* fs.exists(pdfLocation.absolutePath)) {
        compiledFiles.push(pdfLocation);
        log.debug(`Successfully compiled: ${pdfLocation.absolutePath}`);
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
