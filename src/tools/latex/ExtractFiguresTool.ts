// Third-party imports
import { z } from 'zod';

// Local imports - core
import { defineTool } from '@tools/core/define';

// Local imports - latex
import { extractFigurePathsFromLatex } from '@latex';

// Local imports - tools
import { toolResult, ToolResult } from '@tools/result';

// Local imports - utils
import { WorkspaceFS } from '@utils/files';

const LatexFileSchema = z
  .string()
  .min(1, 'Provide the path to a LaTeX source file')
  .refine((value) => value.trim().toLowerCase().endsWith('.tex'), {
    message: 'Only .tex files are supported',
  });

const ExtractFiguresInputSchema = z
  .object({
    files: z
      .union([LatexFileSchema, z.array(LatexFileSchema).min(1)])
      .transform((value) => (Array.isArray(value) ? value : [value])),
  })
  .strict();

export type ExtractFiguresInput = z.infer<typeof ExtractFiguresInputSchema>;

interface FigureDiscovery {
  file: string;
  figures: string[];
}

export class ExtractFiguresTool extends defineTool({
  name: 'extract_figures',
  description:
    'Extract figure file references from one or more LaTeX sources and surface them as attachments.',
  schema: ExtractFiguresInputSchema,
}) {
  protected async execute(input: ExtractFiguresInput): Promise<ToolResult> {
    const discoveries: FigureDiscovery[] = [];
    const attachmentPaths = new Set<string>();

    for (const latexFile of input.files) {
      const figurePaths = await extractFigurePathsFromLatex(latexFile);
      const normalized = Array.from(new Set(figurePaths));

      const existing = await WorkspaceFS.filterExistingFiles(
        normalized.map((path) => ({ path })),
      );
      const resolved = existing.map((entry) => entry.path);
      resolved.forEach((path) => attachmentPaths.add(path));

      discoveries.push({ file: latexFile, figures: normalized });
    }

    const totalFigures = discoveries.reduce(
      (count, discovery) => count + discovery.figures.length,
      0,
    );
    const summary =
      totalFigures > 0
        ? `Found ${totalFigures} figure${totalFigures === 1 ? '' : 's'} across ${
            discoveries.length
          } file${discoveries.length === 1 ? '' : 's'}.`
        : `No figures discovered in ${input.files.length} file${
            input.files.length === 1 ? '' : 's'
          }.`;

    return toolResult({
      summary,
      output: JSON.stringify(discoveries, null, 2),
      files: Array.from(attachmentPaths).map((path) => ({ path })),
    });
  }
}
