// Local imports - log
import { toErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
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

export class DiffFileProcessor {
  constructor(private readonly channel: string) {}

  async processDiffFile(diffFileLocation: FileLocation): Promise<void> {
    try {
      const content = await flexibleFS.read(diffFileLocation);
      let processedContent = this.processStarEnvironments(content);
      processedContent = this.processLineByLine(processedContent);
      processedContent = replacementEngine.applyAll(processedContent);
      await flexibleFS.write(diffFileLocation, processedContent);
      await this.processTikzPictureEndings(diffFileLocation);
    } catch (err) {
      logger.error(
        this.channel,
        `Error processing diff file: ${toErrorMessage(err)}`,
      );
    }
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

      const lineState = this.updateLineState(line, documentStarted);
      documentStarted = lineState.documentStarted;
      skippingPreambleBlock = lineState.skipBlock ?? skippingPreambleBlock;

      if (skippingPreambleBlock) {
        return [];
      }

      return this.formatLine(line);
    });

    return processedLines.join('\n') + '\n';
  }

  private updateLineState(
    line: string,
    documentStarted: boolean,
  ): { documentStarted: boolean; skipBlock?: boolean } {
    if (DOCUMENT_START_MARKERS.some((marker) => line.includes(marker))) {
      return { documentStarted: true, skipBlock: false };
    }
    if (
      !documentStarted &&
      PREAMBLE_SKIP_MARKERS.some((marker) => line.includes(marker))
    ) {
      return { documentStarted, skipBlock: true };
    }
    return { documentStarted };
  }

  private formatLine(line: string): string[] {
    const result: string[] = [];

    if (this.needsNewlineBefore(line)) {
      result.push('');
    }

    result.push(line);

    if (line.includes('\\RequirePackage{color}')) {
      result.push('');
    }

    return result;
  }

  private needsNewlineBefore(line: string): boolean {
    return PACKAGES_NEEDING_NEWLINE.some((pkg) => line.includes(pkg));
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
