import { z } from 'zod';

// ---------------------------------------------------------------------------
// CLI-specific enums
// ---------------------------------------------------------------------------

export const CLI_OUTPUT_FORMATS = ['text', 'json', 'ndjson'] as const;
export type CliOutputFormat = (typeof CLI_OUTPUT_FORMATS)[number];

export const CLI_APPROVAL_POLICIES = ['never', 'ask', 'yolo'] as const;
export type CliApprovalPolicy = (typeof CLI_APPROVAL_POLICIES)[number];

// ---------------------------------------------------------------------------
// Per-key schema registry
// ---------------------------------------------------------------------------

interface SettingEntry<T> {
  readonly schema: z.ZodType<T>;
  readonly default: T;
}

function entry<T>(schema: z.ZodType<T>, defaultValue: T): SettingEntry<T> {
  return { schema, default: defaultValue };
}

export const TEXRA_SETTINGS = {
  // -- Agent outputs -------------------------------------------------------
  'texra.agentOutputs.autoOpenFinal': entry(z.boolean(), true),

  // -- Inline criticism ----------------------------------------------------
  'texra.inlineCriticism.enabled': entry(z.boolean(), false),

  // -- Experimental --------------------------------------------------------
  'texra.experimental.odyssey.enabled': entry(z.boolean(), false),

  // -- UI toggles ----------------------------------------------------------
  'texra.ui.showApiKeyReminders': entry(z.boolean(), true),
  'texra.ui.showLoginBanner': entry(z.boolean(), true),
  'texra.ui.showGettingStartedBanner': entry(z.boolean(), true),
  'texra.ui.showOrchestratorBanner': entry(z.boolean(), true),

  // -- Auth ----------------------------------------------------------------
  'texra.auth.enableVSCodeGitHub': entry(z.boolean(), false),

  // -- Model ---------------------------------------------------------------
  'texra.model.useImprovedConnection': entry(z.boolean(), false),
  'texra.model.improvedConnectionDomain': entry(z.string(), 'proxy.texra.ai'),
  'texra.model.useOpenAIResponsesAPI': entry(z.boolean(), false),
  'texra.model.useBackgroundResponses': entry(z.boolean(), false),
  'texra.model.openaiParallelToolCalls': entry(z.boolean(), true),
  'texra.model.compactionThresholdPercent': entry(
    z.number().min(0).max(100),
    70,
  ),
  'texra.model.gpt5ReasoningSummary': entry(z.string(), 'detailed'),

  // -- Model retry ---------------------------------------------------------
  'texra.model.retry.maxAttempts': entry(z.number().int().min(1), 3),
  'texra.model.retry.backoffMs': entry(z.number().int().min(0), 500),

  // -- Files: included extensions ------------------------------------------
  'texra.files.included.mediaExtensions': entry(z.array(z.string()), [
    '.png',
    '.jpg',
    '.jpeg',
    '.pdf',
    '.gif',
    '.svg',
  ]),
  'texra.files.included.inputExtensions': entry(z.array(z.string()), ['.tex']),
  'texra.files.included.contextExtensions': entry(z.array(z.string()), [
    '.tex',
    '.bib',
    '.cls',
    '.sty',
    '.bst',
    '.cfg',
    '.def',
    '.clo',
    '.bbx',
    '.cbx',
    '.lbx',
    '.tikz',
    '.eps',
    '.svg',
  ]),
  'texra.files.included.editedExtensions': entry(z.array(z.string()), ['.tex']),

  // -- Files: ignored ------------------------------------------------------
  'texra.files.ignored.fileExtensions': entry(z.array(z.string()), [
    '.aux',
    '.bbl',
    '.blg',
    '.fdb_latexmk',
    '.fls',
    '.log',
    '.out',
    '.synctex.gz',
    '.toc',
    '.pdf',
    '.dvi',
    '.ps',
    '.gz',
    '.zip',
    '.tar',
    '.lol',
    '.lot',
    '.lof',
    '.bcf',
    '.run.xml',
    '.xdv',
    '.idx',
    '.ilg',
    '.ind',
  ]),
  'texra.files.ignored.inputFiles': entry(z.array(z.string()), []),
  'texra.files.ignored.inputDirectories': entry(z.array(z.string()), []),
  'texra.files.ignored.mediaDirectories': entry(z.array(z.string()), []),
  'texra.files.ignored.directories': entry(z.array(z.string()), [
    '.git',
    '.vscode',
    'node_modules',
    '__pycache__',
    'build',
    'dist',
    'out',
    'target',
  ]),
  'texra.files.ignored.keywords': entry(z.array(z.string()), []),

  // -- Images --------------------------------------------------------------
  'texra.maxImageDimension': entry(z.number().int().min(1), 2000),

  // -- Bibliography --------------------------------------------------------
  'texra.bib.defaultPath': entry(z.string(), ''),
  'texra.bib.zoteroPort': entry(z.number().int().min(1).max(65535), 23119),

  // -- LaTeX ---------------------------------------------------------------
  'texra.latex.showLatexindentWarning': entry(z.boolean(), true),
  'texra.latex.latexindentConfig': entry(z.string(), ''),
  'texra.latex.texfmtConfig': entry(z.string(), ''),
  'texra.latex.tikzInputDirectory': entry(z.string(), ''),
  'texra.latex.tikzTemplate': entry(z.string(), ''),
  'texra.latex.includeWorkspaceInTexinputs': entry(z.boolean(), false),
  'texra.latex.wrapCritiqueInAlign': entry(z.boolean(), true),

  // -- LaTeX diff ----------------------------------------------------------
  'texra.latexdiff.pictureEnvironments': entry(z.array(z.string()), [
    'tikzpicture',
    'pgfpicture',
  ]),
  'texra.latexdiff.tempFileLocation': entry(z.string(), ''),

  // -- LaTeX replacements --------------------------------------------------
  'texra.latex.enabledReplacements': entry(z.array(z.string()), []),
  'texra.latex.enabledReplacementsRegex': entry(z.array(z.string()), []),
  'texra.latex.customReplacementsRegex': entry(z.array(z.string()), []),
  'texra.latex.customReplacements': entry(z.array(z.string()), []),

  // -- Tool use ------------------------------------------------------------
  'texra.toolUse.persistence.enabled': entry(z.boolean(), true),
  'texra.toolUse.persistence.ttlHours': entry(z.number().int().min(0), 72),
  'texra.toolUse.requireBashApproval': entry(z.boolean(), true),
  'texra.toolUse.requireEditApproval': entry(z.boolean(), false),

  // -- Logger --------------------------------------------------------------
  'texra.logger.debugMode': entry(z.boolean(), false),

  // -- Git -----------------------------------------------------------------
  'texra.git.numberOfCommitsToShow': entry(z.number().int().min(0), 20),
  'texra.git.emitPrCiStartedEvents': entry(z.boolean(), false),

  // -- CLI runtime ---------------------------------------------------------
  'texra.agent': entry(z.string().trim().min(1).optional(), undefined),
  'texra.model': entry(z.string().trim().min(1).optional(), undefined),
  'texra.outputFormat': entry(z.enum(CLI_OUTPUT_FORMATS).optional(), undefined),
  'texra.approvalPolicy': entry(
    z.enum(CLI_APPROVAL_POLICIES).optional(),
    undefined,
  ),
  'texra.chat': entry(
    z
      .object({
        agent: z.string().trim().min(1).optional(),
        model: z.string().trim().min(1).optional(),
      })
      .optional(),
    undefined,
  ),
  'texra.run': entry(
    z
      .object({
        agent: z.string().trim().min(1).optional(),
        model: z.string().trim().min(1).optional(),
      })
      .optional(),
    undefined,
  ),
} as const;

export type TexraSettingsKey = keyof typeof TEXRA_SETTINGS;

// ---------------------------------------------------------------------------
// Derived helpers
// ---------------------------------------------------------------------------

/** Set of all known texra.* config keys. */
export const KNOWN_TEXRA_KEYS: ReadonlySet<string> = new Set(
  Object.keys(TEXRA_SETTINGS),
);

/** Get the default value for a known key, or undefined. */
export function getSettingDefault(key: string): unknown {
  const entry = TEXRA_SETTINGS[key as TexraSettingsKey];
  return entry?.default;
}

/** Validate a single key-value pair against its registered schema. */
export function validateSettingValue(
  key: string,
  value: unknown,
): { success: true; data: unknown } | { success: false; error: z.ZodError } {
  const entry = TEXRA_SETTINGS[key as TexraSettingsKey];
  if (!entry) {
    return { success: true, data: value };
  }
  return entry.schema.safeParse(value);
}

/**
 * Validate a flat record of key-value pairs against the registered schemas.
 * Returns only entries whose keys are known and whose values pass validation.
 */
export function validateSettingsRecord(
  record: Record<string, unknown>,
): Map<string, unknown> {
  const result = new Map<string, unknown>();
  for (const [key, value] of Object.entries(record)) {
    const parsed = validateSettingValue(key, value);
    if (parsed.success) {
      result.set(key, parsed.data);
    }
  }
  return result;
}
