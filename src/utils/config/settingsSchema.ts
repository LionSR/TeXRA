// ---------------------------------------------------------------------------
// CLI-specific enums
// ---------------------------------------------------------------------------

export const CLI_OUTPUT_FORMATS = ['text', 'json', 'ndjson'] as const;
export type CliOutputFormat = (typeof CLI_OUTPUT_FORMATS)[number];

export const CLI_APPROVAL_POLICIES = ['never', 'ask', 'yolo'] as const;
export type CliApprovalPolicy = (typeof CLI_APPROVAL_POLICIES)[number];

// ---------------------------------------------------------------------------
// Known `texra.*` configuration keys
// ---------------------------------------------------------------------------
//
// This is the authoritative list of canonical `texra.*` setting keys used by
// the extension and the CLI for "unknown key" detection. Per-key schemas and
// defaults live in `src/shared/schemas/settingsConfiguration.ts`; this file
// intentionally tracks only the names.

const KEYS = [
  // Agent outputs
  'texra.agentOutputs.autoOpenFinal',
  // Inline criticism
  'texra.inlineCriticism.enabled',
  // Experimental
  'texra.experimental.odyssey.enabled',
  // UI toggles
  'texra.ui.showApiKeyReminders',
  'texra.ui.showLoginBanner',
  'texra.ui.showGettingStartedBanner',
  'texra.ui.showOrchestratorBanner',
  // Auth
  'texra.auth.enableVSCodeGitHub',
  // Model
  'texra.model.useImprovedConnection',
  'texra.model.improvedConnectionDomain',
  'texra.model.useOpenAIResponsesAPI',
  'texra.model.useBackgroundResponses',
  'texra.model.openaiParallelToolCalls',
  'texra.model.compactionThresholdPercent',
  'texra.model.gpt5ReasoningSummary',
  // Model retry
  'texra.model.retry.maxAttempts',
  'texra.model.retry.backoffMs',
  // Files: included
  'texra.files.included.mediaExtensions',
  'texra.files.included.inputExtensions',
  'texra.files.included.contextExtensions',
  'texra.files.included.editedExtensions',
  // Files: ignored
  'texra.files.ignored.fileExtensions',
  'texra.files.ignored.inputFiles',
  'texra.files.ignored.inputDirectories',
  'texra.files.ignored.mediaDirectories',
  'texra.files.ignored.directories',
  'texra.files.ignored.keywords',
  // Images
  'texra.maxImageDimension',
  // Bibliography
  'texra.bib.defaultPath',
  'texra.bib.zoteroPort',
  // LaTeX
  'texra.latex.showLatexindentWarning',
  'texra.latex.latexindentConfig',
  'texra.latex.texfmtConfig',
  'texra.latex.tikzInputDirectory',
  'texra.latex.tikzTemplate',
  'texra.latex.includeWorkspaceInTexinputs',
  'texra.latex.wrapCritiqueInAlign',
  // LaTeX diff
  'texra.latexdiff.pictureEnvironments',
  'texra.latexdiff.tempFileLocation',
  // LaTeX replacements
  'texra.latex.enabledReplacements',
  'texra.latex.enabledReplacementsRegex',
  'texra.latex.customReplacementsRegex',
  'texra.latex.customReplacements',
  // Tool use
  'texra.toolUse.persistence.enabled',
  'texra.toolUse.persistence.ttlHours',
  'texra.toolUse.requireBashApproval',
  'texra.toolUse.requireEditApproval',
  // Logger
  'texra.logger.debugMode',
  // Git
  'texra.git.numberOfCommitsToShow',
  'texra.git.emitPrCiStartedEvents',
  // CLI runtime
  'texra.agent',
  'texra.model',
  'texra.outputFormat',
  'texra.approvalPolicy',
  'texra.chat',
  'texra.run',
] as const;

/** Set of all known canonical `texra.*` config keys. */
export const KNOWN_TEXRA_KEYS: ReadonlySet<string> = new Set(KEYS);
