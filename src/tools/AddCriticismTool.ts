// Third-party imports
import { z } from 'zod';

// Internal imports
import * as logger from '@agent/core/logger';
import { toErrorMessage } from '@common/errors';

// Local file imports
import { defineTool } from './core/define';
import { type ToolResult, ToolError } from './result';

const CHANNEL = 'AddCriticismTool';
logger.initialize(CHANNEL);

/**
 * Shared shape for a single criticism entry. The tool emits this with `path`
 * (which the host resolves to `absolutePath`) and the host re-emits the same
 * shape into the diagnostic collection.
 */
export interface ManualCriticismEntry {
  /** Absolute path resolved by the host. */
  absolutePath: string;
  /** 1-based line number. */
  line: number;
  message: string;
  /** 1–5; mapped to DiagnosticSeverity. */
  severity: number;
  /** 1–5; appended to the message as `(S/C)`. */
  confidence: number;
}

/**
 * Sink injected by the extension host. Returns `accepted: false` when the
 * experimental setting is disabled so the tool can surface that to the agent.
 */
export type AddCriticismSink = (input: {
  path: string;
  line: number;
  message: string;
  severity: number;
  confidence: number;
}) => { accepted: boolean; resolvedPath: string };

let sink: AddCriticismSink = () => ({ accepted: false, resolvedPath: '' });

export function setAddCriticismSink(provider: AddCriticismSink): void {
  sink = provider;
}

export const AddCriticismInputSchema = z.strictObject({
  path: z
    .string()
    .describe(
      'Absolute or workspace-relative path to the file the criticism applies to.',
    ),
  line: z
    .number()
    .int()
    .min(1)
    .describe('1-based line number where the issue occurs.'),
  message: z.string().min(1).describe('Description of the issue.'),
  severity: z
    .number()
    .int()
    .min(1)
    .max(5)
    .describe(
      'Severity 1–5: 5=desk-rejection risk, 4=significantly weakens, 3=worth addressing, 2=minor polish, 1=cosmetic.',
    ),
  confidence: z
    .number()
    .int()
    .min(1)
    .max(5)
    .describe(
      'Confidence 1–5: 5=certain, 4=high certainty with minor subjectivity, 3=reasonable but field-dependent, 2=subjective, 1=speculative.',
    ),
});

export type AddCriticismInput = z.infer<typeof AddCriticismInputSchema>;

export class AddCriticismTool extends defineTool({
  name: 'add_criticism',
  description:
    'Push a critique annotation as a VS Code diagnostic (squiggle + Problems panel entry) for the given file and line. Use this to flag issues without inserting a literal \\criticize{...}{...}{...} macro into the document. Requires the experimental "texra.inlineCriticism.enabled" setting; the tool reports "not accepted" if disabled.',
  schema: AddCriticismInputSchema,
}) {
  protected async execute(input: AddCriticismInput): Promise<ToolResult> {
    try {
      const result = sink(input);
      if (!result.accepted) {
        return {
          summary: 'Criticism not accepted',
          output:
            'Inline criticism diagnostics are disabled. Enable "texra.inlineCriticism.enabled" in settings to surface critiques as diagnostics.',
        };
      }
      const where = result.resolvedPath || input.path;
      const summary = `Added criticism for ${where}:${input.line} (S${input.severity}/C${input.confidence})`;
      return { summary, output: summary };
    } catch (error) {
      const detail = toErrorMessage(error);
      logger.error(CHANNEL, `Failed to add criticism: ${detail}`);
      throw new ToolError(`Failed to add criticism: ${detail}`);
    }
  }
}
