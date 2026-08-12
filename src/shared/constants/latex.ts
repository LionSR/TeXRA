import { WorkspaceStateKey } from '@shared/state/stateKeys';

/** Extension ID for the LaTeX Workshop VS Code extension. */
export const LATEX_WORKSHOP_EXT_ID = 'James-Yu.latex-workshop';

/**
 * Single source of truth for the core LaTeX toolchain name list. `pdflatex,
 * latexmk, latexindent, latexdiff, texcount, perl, gs` are checked directly;
 * the image tool is satisfied by *either* `gm` or `magick` (reported as
 * `gm/magick` in user-facing output), so it lives in its own constant.
 *
 * Lives in `shared` rather than `tools` or `latex` because the `tools`
 * subsystem (`probe_environment`/`verify_setup`), the `latex` subsystem
 * (`latexToolchain.ts`'s doctor-specific probe), and `controllers`
 * (`LatexToolingController`, the settings-view status) all consume it —
 * and `tools` already depends on `latex`, so a `latex`-side or `tools`-side
 * home would create a cross-subsystem cycle the LAY-1 edge ratchet forbids.
 * Keep the tool descriptions in `ProbeEnvironmentTool`/`VerifySetupTool`
 * aligned with these lists — they appear verbatim in the LLM prompt.
 */
export const CORE_LATEX_TOOLS = Object.freeze([
  'pdflatex',
  'latexmk',
  'latexindent',
  'latexdiff',
  'texcount',
  'perl',
  'gs',
] as const);

export const IMAGE_TOOLS = Object.freeze(['gm', 'magick'] as const);

export const NON_REGEX_REPLACEMENT_CATEGORIES = [
  'latex_spacing',
  'equations',
  'sections',
  'latex_forbidden_commands',
  'characters',
  'font_commands',
  'latex_xml',
  'unicode',
  'html_entities',
  'latexdiff',
  'gptness',
  'personal_style',
  'max_style',
] as const;

export const REGEX_REPLACEMENT_CATEGORIES = [
  'fenced_latex_blocks',
  'inline_math',
  'parentheses',
  'latexdiff_markup',
  'equation_style',
  'equation_macros',
  'personal_style_contextual',
  'max_style_regex',
] as const;

export type NonRegexReplacementCategory =
  (typeof NON_REGEX_REPLACEMENT_CATEGORIES)[number];
export type RegexReplacementCategory =
  (typeof REGEX_REPLACEMENT_CATEGORIES)[number];

export const DEFAULT_ENABLED_REPLACEMENTS = [
  'latex_spacing',
  'equations',
  'sections',
  'latex_forbidden_commands',
  'characters',
  'font_commands',
  'latex_xml',
  'unicode',
  'html_entities',
  'latexdiff',
  'gptness',
] satisfies NonRegexReplacementCategory[];

export const DEFAULT_ENABLED_REGEX_REPLACEMENTS = [
  'fenced_latex_blocks',
  'inline_math',
  'parentheses',
  'latexdiff_markup',
  'equation_style',
  'personal_style_contextual',
] satisfies RegexReplacementCategory[];

/** Supported OS platform keys for install guides. */
export type OSPlatform = 'darwin' | 'win32' | 'linux';

// ============================================================
// Install guide builders
// ============================================================

type Guide = Record<OSPlatform, string>;

/** Tool installable via brew, apt, and a download URL. */
function brewAptUrl(
  label: string,
  brew: string,
  apt: string,
  url: string,
): Guide {
  return {
    darwin:
      `Install ${label}:\n  brew install ${brew}\n\n` +
      `"brew" requires Homebrew (https://brew.sh).\n` +
      `Or download directly:\n  ${url}`,
    linux: `Install ${label}:\n  sudo apt-get install ${apt}`,
    win32: `Install ${label}:\n  ${url}`,
  };
}

/** Append optional notes per-platform. */
function withNotes(base: Guide, notes: Partial<Guide>): Guide {
  return {
    darwin: base.darwin + (notes.darwin ? `\n\n${notes.darwin}` : ''),
    linux: base.linux + (notes.linux ? `\n\n${notes.linux}` : ''),
    win32: base.win32 + (notes.win32 ? `\n\n${notes.win32}` : ''),
  };
}

/** TeX Live tool: brew + apt on unix, MiKTeX Console + tlmgr on Windows. */
function texLiveGuide(
  tool: string,
  opts: { brew: string; apt: string; notes?: Partial<Guide> },
): Guide {
  const base: Guide = {
    darwin:
      `Install ${tool}:\n  brew install ${opts.brew}\n\n` +
      `"brew" requires Homebrew (https://brew.sh).`,
    linux: `Install ${tool}:\n  sudo apt-get install ${opts.apt}`,
    win32:
      `MiKTeX: Open MiKTeX Console → Packages → search "${tool}" → Install\n\n` +
      `TeX Live: tlmgr install ${tool}`,
  };
  return opts.notes ? withNotes(base, opts.notes) : base;
}

/** Combine multiple guides into a single multi-section guide. */
function combineGuides(
  ...sections: Array<[label: string, guide: Guide]>
): Guide {
  // Extract just the install command (first paragraph) from each guide
  const commandsFor = (platform: OSPlatform): string =>
    sections
      .map(
        ([label, guide]) =>
          `${label}:\n  ${guide[platform].split('\n\n')[0].split('\n  ')[1]}`,
      )
      .join('\n\n');
  return {
    // A single Homebrew note for macOS instead of repeating it per-section
    darwin:
      commandsFor('darwin') + '\n\n"brew" requires Homebrew (https://brew.sh).',
    linux: commandsFor('linux'),
    win32: commandsFor('win32'),
  };
}

// ============================================================
// Per-tool install guides (single source of truth)
//
// Consumed by:
//   - `toolUtils.ts` TOOL_CONFIGS (runtime error messages)
//   - `LaTeXTab.ts` dependency cards (settings UI)
// ============================================================

// ── Unique guides (no shared pattern) ──────────────────────

export const PDFLATEX_INSTALL_GUIDE: Guide = {
  darwin:
    'Install TeX Live (recommended):\n' +
    '  brew install texlive\n\n' +
    '"brew" requires Homebrew (https://brew.sh), a free\n' +
    'macOS package manager. This is the lean TeX Live\n' +
    "distribution without MacTeX's GUI apps.\n\n" +
    'Alternatives:\n' +
    '  brew install --cask mactex-no-gui   (MacTeX without GUI apps)\n' +
    '  brew install --cask mactex          (full MacTeX, ~4 GB)\n' +
    'Or download MacTeX directly from:\n' +
    '  https://www.tug.org/mactex/mactex-download.html\n\n' +
    'After installing, restart VS Code and verify by running\n' +
    '"pdflatex --version" in Terminal.',
  linux:
    'Install TeX Live:\n' +
    '  sudo apt-get install texlive-full\n\n' +
    'After installing, restart VS Code and verify by running\n' +
    '"pdflatex --version" in a terminal.',
  win32:
    'Install MiKTeX (recommended for Windows):\n' +
    '  https://miktex.org/download\n' +
    '  Download the installer, run it, and choose "Install\n' +
    '  missing packages on the fly" when prompted.\n\n' +
    'Or TeX Live:\n' +
    '  https://tug.org/texlive/\n\n' +
    'After installing, restart VS Code and verify by running\n' +
    '"pdflatex --version" in Command Prompt.',
};

export const PERL_INSTALL_GUIDE: Guide = {
  darwin:
    'Perl is pre-installed on macOS.\n' +
    'If missing, reinstall via:\n' +
    '  brew install perl\n\n' +
    '"brew" requires Homebrew (https://brew.sh).',
  linux: 'Install Perl:\n  sudo apt-get install perl',
  win32:
    'Install Strawberry Perl (recommended):\n  https://strawberryperl.com/',
};

export const TEXFMT_INSTALL_GUIDE: Guide = {
  darwin:
    'Install tex-fmt:\n  brew install tex-fmt\n\n' +
    '"brew" requires Homebrew (https://brew.sh).\n\n' +
    'Or via Cargo:\n  cargo install tex-fmt',
  linux:
    'Install tex-fmt:\n  apt install tex-fmt\n\n' +
    'Or via Cargo:\n  cargo install tex-fmt',
  win32: 'Install tex-fmt via Cargo:\n  cargo install tex-fmt',
};

export const WOLFRAM_INSTALL_GUIDE: Guide = {
  darwin:
    'TeXRA requires the "wolframscript" command-line tool.\n\n' +
    'Install the free Wolfram Engine:\n' +
    '  brew install --cask wolfram-engine\n\n' +
    '"brew" requires Homebrew (https://brew.sh).\n' +
    'Or download from:\n  https://www.wolfram.com/engine/\n\n' +
    'Note: A Mathematica installation alone is not enough.\n' +
    'You need WolframScript on your PATH. The Wolfram Engine\n' +
    'includes it automatically.',
  linux:
    'TeXRA requires the "wolframscript" command-line tool.\n\n' +
    'Install the free Wolfram Engine:\n' +
    '  https://www.wolfram.com/engine/\n\n' +
    'Note: A Mathematica installation alone is not enough.\n' +
    'You need WolframScript on your PATH. The Wolfram Engine\n' +
    'includes it automatically.',
  win32:
    'TeXRA requires the "wolframscript" command-line tool.\n\n' +
    'Install the free Wolfram Engine:\n' +
    '  https://www.wolfram.com/engine/\n\n' +
    'Note: A Mathematica installation alone is not enough.\n' +
    'You need WolframScript on your PATH. The Wolfram Engine\n' +
    'includes it automatically.',
};

// ── Simple brew / apt / URL tools ──────────────────────────

export const GHOSTSCRIPT_INSTALL_GUIDE = brewAptUrl(
  'Ghostscript',
  'ghostscript',
  'ghostscript',
  'https://ghostscript.com/releases/gsdnld.html',
);

export const GRAPHICSMAGICK_INSTALL_GUIDE = brewAptUrl(
  'GraphicsMagick',
  'graphicsmagick',
  'graphicsmagick',
  'http://www.graphicsmagick.org/download.html',
);

export const IMAGEMAGICK_INSTALL_GUIDE = brewAptUrl(
  'ImageMagick',
  'imagemagick',
  'imagemagick',
  'https://imagemagick.org/script/download.php',
);

export const PANDOC_INSTALL_GUIDE = brewAptUrl(
  'pandoc',
  'pandoc',
  'pandoc',
  'https://pandoc.org/installing.html',
);

// ── TeX Live tools (brew + apt + MiKTeX/tlmgr) ────────────

const TEX_EXTRA = 'Part of most TeX Live distributions (texlive-extra-utils).';
const TEX_DIST = 'Part of most TeX Live distributions.';

export const LATEXDIFF_INSTALL_GUIDE = texLiveGuide('latexdiff', {
  brew: 'latexdiff',
  apt: 'latexdiff',
  notes: {
    darwin: 'Also included with MacTeX (texlive-extra-utils).',
    linux: TEX_EXTRA,
    win32: TEX_EXTRA,
  },
});

export const LATEXINDENT_INSTALL_GUIDE = texLiveGuide('latexindent', {
  brew: 'latexindent',
  apt: 'texlive-extra-utils',
  notes: {
    darwin:
      'Also included with MacTeX. Requires Perl (pre-installed on macOS).',
    linux: 'Requires Perl:\n  sudo apt-get install perl',
    win32:
      'Also requires Perl (Strawberry Perl recommended):\n  https://strawberryperl.com/',
  },
});

export const TEXCOUNT_INSTALL_GUIDE = texLiveGuide('texcount', {
  brew: 'texcount',
  apt: 'texlive-extra-utils',
  notes: {
    darwin: 'Also included with MacTeX and most TeX Live distributions.',
    linux: TEX_DIST,
    win32: TEX_DIST,
  },
});

export const LATEXMK_INSTALL_GUIDE = texLiveGuide('latexmk', {
  brew: 'latexmk',
  apt: 'latexmk',
  notes: { darwin: 'Also included with MacTeX.' },
});

// ── Composite guide (image processing bundle) ──────────────

export const IMAGE_PROCESSING_INSTALL_GUIDE = combineGuides(
  ['Ghostscript', GHOSTSCRIPT_INSTALL_GUIDE],
  ['GraphicsMagick (recommended)', GRAPHICSMAGICK_INSTALL_GUIDE],
  ['Or ImageMagick', IMAGEMAGICK_INSTALL_GUIDE],
);

// ============================================================
// Structured install commands (for Copy / Run in Terminal)
// ============================================================

/**
 * A concrete install command for a dependency on a given platform.
 * Used by the LaTeX tab to power "Copy command" and "Run in Terminal" buttons.
 */
export interface InstallCommand {
  /** The full shell command (e.g. "brew install ghostscript"). */
  readonly command: string;
  /**
   * The package manager the command targets.
   * `null` means the command is always available (e.g. a direct download URL).
   */
  readonly packageManager: 'brew' | 'apt' | 'scoop' | null;
}

/** Official Homebrew one-liner install script. */
export const HOMEBREW_INSTALL_COMMAND =
  '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';

/** Official Scoop install commands (PowerShell). */
export const SCOOP_INSTALL_COMMAND =
  'Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser; irm get.scoop.sh | iex';

/**
 * Per-dependency install commands keyed by `DependencyInfo.key`.
 *
 * Each platform maps to an **ordered** list of install options, ranked by
 * recommendation priority. The frontend picks the first option whose
 * `packageManager` matches the detected system package manager (or whose
 * `packageManager` is `null`, meaning always available).
 *
 * An empty array means there is no automatable install for that platform.
 */
export const DEPENDENCY_INSTALL_COMMANDS: Record<
  string,
  Record<OSPlatform, readonly InstallCommand[]>
> = {
  texDistributionInstalled: {
    darwin: [
      {
        command: 'brew install texlive',
        packageManager: 'brew',
      },
    ],
    linux: [
      {
        command: 'sudo apt-get install -y texlive-full',
        packageManager: 'apt',
      },
    ],
    win32: [
      {
        command: 'scoop install miktex',
        packageManager: 'scoop',
      },
    ],
  },
  latexdiffInstalled: {
    darwin: [
      {
        command: 'brew install latexdiff',
        packageManager: 'brew',
      },
    ],
    linux: [
      {
        command: 'sudo apt-get install -y latexdiff',
        packageManager: 'apt',
      },
    ],
    win32: [],
  },
  latexindentInstalled: {
    darwin: [
      {
        command: 'brew install latexindent',
        packageManager: 'brew',
      },
    ],
    linux: [
      {
        command: 'sudo apt-get install -y texlive-extra-utils perl',
        packageManager: 'apt',
      },
    ],
    win32: [],
  },
  texcountInstalled: {
    darwin: [
      {
        command: 'brew install texcount',
        packageManager: 'brew',
      },
    ],
    linux: [
      {
        command: 'sudo apt-get install -y texlive-extra-utils',
        packageManager: 'apt',
      },
    ],
    win32: [],
  },
  imageProcessingInstalled: {
    darwin: [
      {
        command: 'brew install ghostscript graphicsmagick',
        packageManager: 'brew',
      },
    ],
    linux: [
      {
        command: 'sudo apt-get install -y ghostscript graphicsmagick',
        packageManager: 'apt',
      },
    ],
    win32: [
      {
        command: 'scoop install ghostscript graphicsmagick',
        packageManager: 'scoop',
      },
    ],
  },
};

// ============================================================
// LaTeX-specific timing constants
// ============================================================

/** Delay before registering a diff document for side-by-side view. */
export const DIFF_REGISTRATION_DELAY_MS = 300;

/** Delay before auto-opening the LaTeX viewer after build. */
export const LATEX_VIEWER_OPEN_DELAY_MS = 5000;

/** Delay before refreshing the LaTeX viewer after build. */
export const LATEX_VIEWER_REFRESH_DELAY_MS = 5000;

// ============================================================
// Utility functions
// ============================================================

/**
 * Normalize a raw platform string to one of the three supported values.
 * Falls back to 'linux' for unrecognized platforms (e.g. 'freebsd').
 */
export function normalizePlatform(raw: string): OSPlatform {
  return raw === 'darwin' || raw === 'win32' ? raw : 'linux';
}

/**
 * Select the install guide for the given platform.
 * Falls back to linux if the platform is unrecognized.
 */
export function getInstallGuide(guide: Guide, platform: string): string {
  return guide[normalizePlatform(platform)];
}

// ============================================================
// LaTeX/compile/diff config — single source of truth
// ============================================================
//
// These constants are imported by:
//   - readers in src/agent/, src/latex/, src/housekeeping/, src/commands/
//   - the inbound/outbound message schemas in src/shared/schemas/
//   - the native LaTeX settings handlers and tab UI
// so changing a default or range here propagates everywhere with no rot.
//
/** Numeric range for a setting (used by Zod schemas and UI inputs). */
export interface NumericRange {
  readonly min: number;
  readonly max?: number;
}

/** Allowed values for the `latexdiff` math-markup mode. */
export const LATEXDIFF_MATH_MARKUP_VALUES = [
  'off',
  'whole',
  'coarse',
  'fine',
] as const;
export type LatexdiffMathMarkupValue =
  (typeof LATEXDIFF_MATH_MARKUP_VALUES)[number];

/** Allowed values for the LaTeX formatter selector. */
export const LATEX_FORMATTER_VALUES = [
  'latexindent',
  'tex-fmt',
  'none',
] as const;
export type LatexFormatterValue = (typeof LATEX_FORMATTER_VALUES)[number];

/** Documented defaults — match the values that used to live in package.json. */
export const LATEX_CONFIG_DEFAULTS = {
  workflowAutoCompile: true,
  workflowAutoCompileTimeoutMs: 120000,
  workflowAutoOpenPdf: true,
  workflowRejectOnCompileFailure: true,
  latexdiffBetweenRounds: false,
  latexdiffTimeoutMs: 10000,
  latexdiffMathMarkup: 'coarse' as LatexdiffMathMarkupValue,
  latexdiffChangesOnly: true,
  latexFormatter: 'latexindent' as LatexFormatterValue,
} as const;

/** Numeric ranges (used by Zod schemas and UI inputs). */
export const LATEX_CONFIG_RANGES = {
  workflowAutoCompileTimeoutMs: { min: 10000 } satisfies NumericRange,
  latexdiffTimeoutMs: { min: 1000, max: 80000 } satisfies NumericRange,
} as const;

/**
 * Webview-facing field name → WorkspaceStateKey. Single source of truth for
 * both read and write paths, replacing per-handler maps that previously
 * duplicated this list.
 */
export const LATEX_FIELD_TO_KEY = {
  workflowAutoCompile: WorkspaceStateKey.WORKFLOW_AUTO_COMPILE,
  workflowAutoCompileTimeoutMs:
    WorkspaceStateKey.WORKFLOW_AUTO_COMPILE_TIMEOUT_MS,
  workflowAutoOpenPdf: WorkspaceStateKey.WORKFLOW_AUTO_OPEN_PDF,
  workflowRejectOnCompileFailure:
    WorkspaceStateKey.WORKFLOW_REJECT_ON_COMPILE_FAILURE,
  latexdiffBetweenRounds: WorkspaceStateKey.LATEXDIFF_BETWEEN_ROUNDS,
  latexdiffTimeoutMs: WorkspaceStateKey.LATEXDIFF_TIMEOUT_MS,
  latexdiffMathMarkup: WorkspaceStateKey.LATEXDIFF_MATH_MARKUP,
  latexdiffChangesOnly: WorkspaceStateKey.LATEXDIFF_CHANGES_ONLY,
  latexFormatter: WorkspaceStateKey.LATEX_FORMATTER,
} as const;
export type LatexConfigField = keyof typeof LATEX_FIELD_TO_KEY;

/**
 * Replacement-related webview field name → core config key (`texra.latex.*`).
 * Unlike {@link LATEX_FIELD_TO_KEY} these live in core config, not
 * WorkspaceState. Shared by the settings-view frontend (LaTeXTab) and the
 * backend persistence controller so the two sides of the wire can't drift.
 */
export const LATEX_REPLACEMENT_FIELD_TO_CONFIG_KEY = {
  wrapCritiqueInAlign: 'texra.latex.wrapCritiqueInAlign',
  enabledReplacements: 'texra.latex.enabledReplacements',
  enabledReplacementsRegex: 'texra.latex.enabledReplacementsRegex',
  customReplacementsRegex: 'texra.latex.customReplacementsRegex',
  customReplacements: 'texra.latex.customReplacements',
} as const;

/**
 * Workspace directories that bulk file operations (formatting, cleaning,
 * packing) skip — generated artifacts and TeXRA-managed bookkeeping dirs.
 * Compared case-insensitively (lowercase entries).
 */
export const EXCLUDED_DIRS = new Set([
  'figs',
  'figures',
  'media',
  'medias',
  'build',
  'versions',
  'history',
  'notes',
  'diffs',
]);
