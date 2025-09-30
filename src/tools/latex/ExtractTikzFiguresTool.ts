// Third-party imports
import { z } from 'zod';

// Local imports - core
import { defineTool } from '@tools/core/define';

// Local imports - latex
import { tikzPictureManager } from '@latex';

// Local imports - tools
import { toolResult, ToolResult } from '@tools/result';

const LatexFileSchema = z
  .string()
  .min(1, 'Provide the path to a LaTeX source file')
  .refine((value) => value.trim().toLowerCase().endsWith('.tex'), {
    message: 'Only .tex files are supported',
  });

const ExtractTikzInputSchema = z
  .object({
    files: z
      .union([LatexFileSchema, z.array(LatexFileSchema).min(1)])
      .transform((value) => (Array.isArray(value) ? value : [value])),
    compile: z.boolean().optional().default(false),
  })
  .strict();

export type ExtractTikzInput = z.infer<typeof ExtractTikzInputSchema>;

interface TikzDiscovery {
  file: string;
  labels: Array<{ label: string; tikz: string[] }>;
  compiled: string[];
}

export class ExtractTikzFiguresTool extends defineTool({
  name: 'extract_tikz_figures',
  description:
    'Discover TikZ figures grouped by figure label and optionally compile standalone artifacts.',
  schema: ExtractTikzInputSchema,
}) {
  protected async execute(input: ExtractTikzInput): Promise<ToolResult> {
    const discoveries: TikzDiscovery[] = [];
    const attachmentPaths = new Set<string>();

    for (const latexFile of input.files) {
      const labeledPictures = await tikzPictureManager.extract(latexFile);
      const labels = labeledPictures.map(([label, tikz]) => ({ label, tikz }));

      let compiled: string[] = [];
      if (input.compile) {
        compiled = await tikzPictureManager.compile(latexFile);
        compiled.forEach((path) => attachmentPaths.add(path));
      }

      discoveries.push({ file: latexFile, labels, compiled });
    }

    const totalLabels = discoveries.reduce(
      (count, discovery) => count + discovery.labels.length,
      0,
    );
    const summary =
      totalLabels > 0
        ? `Found ${totalLabels} labeled TikZ figure${totalLabels === 1 ? '' : 's'} across ${
            discoveries.length
          } file${discoveries.length === 1 ? '' : 's'}.`
        : `No TikZ figures discovered in ${input.files.length} file${
            input.files.length === 1 ? '' : 's'
          }.`;

    return toolResult({
      summary,
      output: JSON.stringify(discoveries, null, 2),
      files: Array.from(attachmentPaths).map((path) => ({ path })),
    });
  }
}
