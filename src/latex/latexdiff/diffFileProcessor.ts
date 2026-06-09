import replacementEngine from '@replacement/engine';
import { flexibleFS, type FileLocation } from '@utils/files';

/** LaTeX starred math environments that need label removal during diff processing. */
const STAR_ENVIRONMENTS = [
  'align\\*',
  'equation\\*',
  'gather\\*',
  'multline\\*',
  'flalign\\*',
  'alignat\\*',
];

/** Substrings that trigger extra newlines before the line for readability. */
const PACKAGES_NEEDING_NEWLINE = [
  '\\usepackage{tikz}',
  '\\usepackage{pgfplots}',
  '\\providecommand{\\DIFaddbegin}',
  '\\RequirePackage[normalem]{ulem}',
  '\\usetikzlibrary',
  '\\RequirePackage{color}',
] as const;

/** Pattern to match TEX root comments (handles various spacing: %!TEX, % !TEX, %! TEX). */
const TEX_ROOT_COMMENT = /^%\s?!\s?TEX root/;

/** Markers that indicate start of preamble content to skip (before document starts). */
const PREAMBLE_SKIP_MARKERS = ['%DIF ADD', 'Here is', '以下是'];

/** Markers that indicate document structure has begun. */
const DOCUMENT_START_MARKERS = ['\\documentclass', '\\input'];

/** Patterns to fix broken document endings after latexdiff processing. */
const DOCUMENT_END_FIXES: Array<[RegExp, string]> = [
  [/\\end\{document\}\s*\\chapter/g, '\\chapter'],
  [/\\end\{document\}\s*\\addcontentsline/g, '\\addcontentsline'],
];

/** Flattened .bbl blocks can contain macro definitions that latexdiff corrupts. */
const THEBIBLIOGRAPHY_BLOCK =
  /\\begin\{thebibliography\}\{[^}]*\}[\s\S]*?\\end\{thebibliography\}/g;

/** The real bibliography entries start here; only sanitize generated macros before it. */
const BIBITEM_START = /(?:^|\n)\s*(?:\\DIF(?:add|del)\{)?\\bibitem\b/;

export class DiffFileProcessor {
  // Intentionally does not swallow failures: a read/transform/write error here
  // means the diff output is missing or corrupt, so it must propagate to the
  // caller (LaTeXdiffService.runDiff*/), whose catch turns it into a
  // `{ success: false }` result. Swallowing it would falsely report success.
  async processDiffFile(
    diffFileLocation: FileLocation,
    editedFileLocation?: FileLocation,
  ): Promise<void> {
    const content = await flexibleFS.read(diffFileLocation);
    const editedContent = editedFileLocation
      ? await flexibleFS.read(editedFileLocation)
      : undefined;
    let processedContent = this.restoreFlattenedBibliography(
      content,
      editedContent,
    );
    processedContent = this.processStarEnvironments(processedContent);
    processedContent = this.processLineByLine(processedContent);
    processedContent = replacementEngine.applyAll(processedContent);
    await flexibleFS.write(diffFileLocation, processedContent);
    await this.processTikzPictureEndings(diffFileLocation);
  }

  private restoreFlattenedBibliography(
    content: string,
    editedContent?: string,
  ): string {
    const bibliography = this.findBibliographyDirective(editedContent);
    if (!bibliography) {
      return this.sanitizeFlattenedBibliographyMacroPreamble(content);
    }

    return content.replaceAll(THEBIBLIOGRAPHY_BLOCK, bibliography);
  }

  private findBibliographyDirective(content?: string): string | undefined {
    for (const line of content?.split('\n') ?? []) {
      if (line.trimStart().startsWith('%')) {
        continue;
      }
      const bibliography = line.match(/\\bibliography\s*\{[^}]+\}/);
      if (bibliography) {
        return bibliography[0];
      }
    }
    return undefined;
  }

  private sanitizeFlattenedBibliographyMacroPreamble(content: string): string {
    return content.replaceAll(THEBIBLIOGRAPHY_BLOCK, (block) => {
      const bibitemStart = BIBITEM_START.exec(block);
      const preambleEnd = bibitemStart?.index ?? block.length;
      const preamble = block.slice(0, preambleEnd);
      if (!preamble.includes('\\DIFadd') && !preamble.includes('\\DIFdel')) {
        return block;
      }

      return (
        this.stripLatexdiffMarkupFromMacroPreamble(preamble) +
        block.slice(preambleEnd)
      );
    });
  }

  private stripLatexdiffMarkupFromMacroPreamble(content: string): string {
    let sanitized = content
      .replaceAll(/%DIF\s*>/g, '%')
      .replaceAll(
        /\\DIF(?:add|del)\{\\mbox\{%DIFAUXCMD\s*\r?\n\\([A-Za-z@]+)\s*\}\\hskip0pt%DIFAUXCMD\s*\r?\n\}/g,
        '\\$1 ',
      );

    let previous: string;
    do {
      previous = sanitized;
      sanitized = sanitized.replaceAll(/\\DIF(?:add|del)\{([^{}]*)\}/g, '$1');
    } while (sanitized !== previous);

    return sanitized;
  }

  private processStarEnvironments(content: string): string {
    const envPattern = STAR_ENVIRONMENTS.join('|');
    const starEnvRegex = new RegExp(
      `\\\\begin\\{(${envPattern})\\}([\\s\\S]*?)\\\\end\\{\\1\\}`,
      'g',
    );

    return content.replaceAll(starEnvRegex, (_match, envName, envContent) => {
      const cleanContent = envContent.replaceAll(/\\label\{[^}]*\}/g, '');
      return `\\begin{${envName}}${cleanContent}\\end{${envName}}`;
    });
  }

  private processLineByLine(content: string): string {
    let skippingPreambleBlock = false;
    let documentStarted = false;

    const processedLines = content.split('\n').flatMap((line) => {
      if (TEX_ROOT_COMMENT.test(line)) {
        return [];
      }

      if (DOCUMENT_START_MARKERS.some((marker) => line.includes(marker))) {
        documentStarted = true;
        skippingPreambleBlock = false;
      } else if (
        !documentStarted &&
        PREAMBLE_SKIP_MARKERS.some((marker) => line.includes(marker))
      ) {
        skippingPreambleBlock = true;
      }

      if (skippingPreambleBlock) {
        return [];
      }

      const result: string[] = [];
      if (PACKAGES_NEEDING_NEWLINE.some((pkg) => line.includes(pkg))) {
        result.push('');
      }
      result.push(line);
      if (line.includes('\\RequirePackage{color}')) {
        result.push('');
      }
      return result;
    });

    return processedLines.join('\n') + '\n';
  }

  private async processTikzPictureEndings(
    fileLocation: FileLocation,
  ): Promise<void> {
    let content = await flexibleFS.read(fileLocation);

    for (const [pattern, replacement] of DOCUMENT_END_FIXES) {
      content = content.replace(pattern, replacement);
    }

    await flexibleFS.write(fileLocation, content);
  }
}
