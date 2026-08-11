import replacementEngine from '@replacement/engine';
import type { FileLocation } from '@shared/schemas';
import { AbsoluteFS } from '@utils/files/absoluteFS';

/** LaTeX starred math environments that need label removal during diff processing. */
const STAR_ENVIRONMENTS = [
  'align\\*',
  'equation\\*',
  'gather\\*',
  'multline\\*',
  'flalign\\*',
  'alignat\\*',
];

const STAR_ENV_REGEX = new RegExp(
  `\\\\begin\\{(${STAR_ENVIRONMENTS.join('|')})\\}([\\s\\S]*?)\\\\end\\{\\1\\}`,
  'g',
);

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
const DOCUMENT_END_FIXES: [RegExp, string][] = [
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
    const content = await AbsoluteFS.read(diffFileLocation.absolutePath);
    const editedContent = editedFileLocation
      ? await AbsoluteFS.read(editedFileLocation.absolutePath)
      : undefined;
    let processedContent = this.restoreFlattenedBibliography(
      content,
      editedContent,
    );
    processedContent = this.processStarEnvironments(processedContent);
    processedContent = this.processLineByLine(processedContent);
    processedContent = replacementEngine.applyAll(processedContent);
    for (const [pattern, replacement] of DOCUMENT_END_FIXES) {
      processedContent = processedContent.replace(pattern, replacement);
    }
    await AbsoluteFS.write(diffFileLocation.absolutePath, processedContent);
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
    // First \bibliography directive on a non-comment line.
    return content?.match(
      /^(?![^\S\r\n]*%).*?(\\bibliography\s*\{[^}]+\})/m,
    )?.[1];
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
    return content.replaceAll(STAR_ENV_REGEX, (_match, envName, envContent) => {
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
}
