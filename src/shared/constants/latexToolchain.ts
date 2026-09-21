/**
 * LaTeX toolchain constants: the dependency catalog, the per-tool install guides
 * and structured install commands, and the platform normalization helpers they
 * share. Split out of the old `@shared/constants/latex` dumping ground.
 */

/** Extension ID for the LaTeX Workshop VS Code extension. */
export const LATEX_WORKSHOP_EXT_ID = 'James-Yu.latex-workshop';

// ============================================================
// Dependency catalog
// ============================================================

/**
 * What `texra doctor` makes of one dependency. A missing `required` row fails
 * the report, which is what sets the CLI's nonzero exit code; a missing
 * `optional` row only warns. `none` means the doctor does not probe the tool
 * at all, so it renders no row for it.
 *
 * Known residual, stated rather than hidden: `latexmk` is `required` even
 * though a pdflatex-only machine counts as having a compiler and
 * `compileLatex2Pdf` falls back to a single pdflatex pass on it (degraded —
 * bibliography, cross-references, and index may be incomplete). So such a
 * machine passes the `latex.compiler` check and still exits nonzero on the
 * `latex.latexmk` row. Demoting latexmk to a warning changes `doctorExitCode`
 * for a real machine configuration, which is a product decision, not a
 * consolidation.
 */
type DoctorRole =
  | { readonly row: 'none' }
  | { readonly row: 'required' | 'optional'; readonly purpose: string };

/**
 * What the setup assistant (`probe_environment`, `verify_setup`) and the
 * settings view's LaTeX tab make of one dependency. A `required` tool is
 * reported missing under its own name; the `image` tools are interchangeable,
 * so either one alone satisfies the image capability and both absent report a
 * single `gm/magick` entry; `none` means neither surface probes it.
 */
type ProbeRole = 'required' | 'image' | 'none';

interface LatexToolEntry {
  /** The binary name, probed as `<name> --version` or on PATH. */
  readonly name: string;
  readonly doctor: DoctorRole;
  readonly probe: ProbeRole;
  /**
   * True when `compileLatex2Pdf` can actually drive this compiler: it runs
   * `latexmk` and falls back to `pdflatex`. Nothing here can invoke `xelatex`
   * or `lualatex` and no setting selects a compiler, so they must not count
   * as "a compiler is available".
   */
  readonly drivesCompile?: true;
  /** Probed by the dependency banner (`checkCoreDependencies`). */
  readonly core?: true;
}

/**
 * The one catalog of external LaTeX and image dependencies TeXRA probes, and
 * what each one means to each consumer that probes it. Four surfaces read it
 * and none restates a name: the doctor probe (`@latex/latexToolchain`), the
 * setup assistant's (`@tools/setup/toolProbing`), the settings view's LaTeX
 * status (`@controllers/settingsView/LatexToolingController`), and the
 * dependency banner (`checkCoreDependencies` in `@utils/system/toolUtils`).
 *
 * The order is the doctor's row order, which is user-visible CLI output.
 *
 * Lives in `shared` rather than `tools` or `latex` because all three
 * subsystems consume it — and `tools` already depends on `latex`, so a
 * `latex`-side or `tools`-side home would create the cross-subsystem cycle the
 * LAY-1 edge ratchet forbids. Keep the tool descriptions in
 * `ProbeEnvironmentTool`/`VerifySetupTool` aligned with the `required` and
 * `image` entries here — they appear verbatim in the LLM prompt.
 */
const LATEX_TOOLS = [
  {
    name: 'latexmk',
    doctor: { row: 'required', purpose: 'LaTeX build orchestration' },
    probe: 'required',
    drivesCompile: true,
  },
  {
    name: 'pdflatex',
    doctor: { row: 'optional', purpose: 'PDFLaTeX compiler' },
    probe: 'required',
    drivesCompile: true,
  },
  {
    name: 'xelatex',
    doctor: { row: 'optional', purpose: 'XeLaTeX compiler' },
    probe: 'none',
  },
  {
    name: 'lualatex',
    doctor: { row: 'optional', purpose: 'LuaLaTeX compiler' },
    probe: 'none',
  },
  {
    name: 'bibtex',
    doctor: { row: 'optional', purpose: 'BibTeX bibliography processing' },
    probe: 'none',
  },
  {
    name: 'biber',
    doctor: { row: 'optional', purpose: 'Biber bibliography processing' },
    probe: 'none',
  },
  {
    name: 'latexdiff',
    doctor: { row: 'optional', purpose: 'LaTeX diff generation' },
    probe: 'required',
  },
  {
    name: 'latexindent',
    doctor: { row: 'optional', purpose: 'LaTeX formatting' },
    probe: 'required',
    core: true,
  },
  { name: 'texcount', doctor: { row: 'none' }, probe: 'required' },
  { name: 'perl', doctor: { row: 'none' }, probe: 'required', core: true },
  { name: 'gs', doctor: { row: 'none' }, probe: 'required', core: true },
  { name: 'gm', doctor: { row: 'none' }, probe: 'image' },
  { name: 'magick', doctor: { row: 'none' }, probe: 'image' },
] as const satisfies readonly LatexToolEntry[];

type CatalogEntry = (typeof LATEX_TOOLS)[number];

type EntryWith<Role extends ProbeRole> = Extract<CatalogEntry, { probe: Role }>;

type CompilerEntry = Extract<CatalogEntry, { drivesCompile: true }>;

type CoreEntry = Extract<CatalogEntry, { core: true }>;

type DoctorEntry = Extract<
  CatalogEntry,
  { doctor: { row: 'required' | 'optional' } }
>;

/** A dependency the setup assistant and the settings view both probe. */
export type ProbedLatexTool = EntryWith<'required' | 'image'>['name'];

/** One of the interchangeable image tools. */
type ImageLatexTool = EntryWith<'image'>['name'];

/** A compiler `compileLatex2Pdf` can drive. */
type SupportedLatexCompiler = CompilerEntry['name'];

/**
 * The dependency set the setup assistant and the settings view probe: the
 * LaTeX toolchain plus both image-tool candidates. One spelling of that list;
 * the copies it replaces were kept in step by hand.
 */
export const PROBED_LATEX_TOOLS: readonly ProbedLatexTool[] =
  LATEX_TOOLS.filter(
    (tool): tool is EntryWith<'required' | 'image'> => tool.probe !== 'none',
  ).map((tool) => tool.name);

/** The named tools the dependency banner probes; derived, not restated. */
export const CORE_DEPENDENCY_TOOLS: readonly CoreEntry['name'][] =
  LATEX_TOOLS.filter((t): t is CoreEntry => 'core' in t).map((t) => t.name);

/** The image tools; either one alone satisfies the image capability. */
export const IMAGE_LATEX_TOOLS: readonly ImageLatexTool[] = LATEX_TOOLS.filter(
  (tool): tool is EntryWith<'image'> => tool.probe === 'image',
).map((tool) => tool.name);

/**
 * How user-facing output names the image capability when neither candidate is
 * installed: one entry, not two, because either tool satisfies it.
 */
export const IMAGE_TOOL_LABEL = 'gm/magick';

/** A dependency `texra doctor` renders a row for. */
type DoctorLatexToolName = DoctorEntry['name'];

/**
 * What one dependency means to `texra doctor`, flattened into the row it
 * renders. The doctor owns the rendering; this is the fact behind it.
 */
export interface DoctorLatexTool {
  /** The binary name; the row's id is `latex.<name>`. */
  readonly name: DoctorLatexToolName;
  /** A missing required tool fails the report and sets a nonzero exit code. */
  readonly required: boolean;
  readonly purpose: string;
}

/** The dependencies `texra doctor` renders a row for, in row order. */
export const DOCTOR_LATEX_TOOLS: readonly DoctorLatexTool[] =
  LATEX_TOOLS.filter(
    (tool): tool is DoctorEntry => tool.doctor.row !== 'none',
  ).map((tool) => ({
    name: tool.name,
    required: tool.doctor.row === 'required',
    purpose: tool.doctor.purpose,
  }));

/**
 * The LaTeX-to-PDF compilers TeXRA can actually drive. Single source for that
 * answer — the doctor probe, the compile-check guard, the compile option enum,
 * and the settings view's TeX-distribution row — so none of them can disagree
 * with the advice text.
 */
export const SUPPORTED_LATEX_COMPILERS: readonly SupportedLatexCompiler[] =
  LATEX_TOOLS.filter(
    (tool): tool is CompilerEntry => 'drivesCompile' in tool,
  ).map((tool) => tool.name);

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
 * The `LatexSettingsStatus` fields `DEPENDENCY_INSTALL_COMMANDS` has an entry
 * for. Closed so a typo'd key fails at compile time instead of silently
 * missing the lookup in `DependencyInfo.key` (`keyof LatexSettingsStatus`,
 * a much wider interface that also carries `platform`, detected paths, and
 * `latexWorkshopInstalled`, which installs through a VS Code command instead).
 */
type DependencyInstallKey =
  | 'texDistributionInstalled'
  | 'latexdiffInstalled'
  | 'latexindentInstalled'
  | 'texcountInstalled'
  | 'imageProcessingInstalled';

/** One install option for a package manager; the table below is all three. */
const forManager =
  (packageManager: InstallCommand['packageManager']) =>
  (command: string): InstallCommand => ({ command, packageManager });

const brew = forManager('brew');
const apt = forManager('apt');
const scoop = forManager('scoop');

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
  DependencyInstallKey,
  Record<OSPlatform, readonly InstallCommand[]>
> = {
  texDistributionInstalled: {
    darwin: [brew('brew install texlive')],
    linux: [apt('sudo apt-get install -y texlive-full')],
    win32: [scoop('scoop install miktex')],
  },
  latexdiffInstalled: {
    darwin: [brew('brew install latexdiff')],
    linux: [apt('sudo apt-get install -y latexdiff')],
    win32: [],
  },
  latexindentInstalled: {
    darwin: [brew('brew install latexindent')],
    linux: [apt('sudo apt-get install -y texlive-extra-utils perl')],
    win32: [],
  },
  texcountInstalled: {
    darwin: [brew('brew install texcount')],
    linux: [apt('sudo apt-get install -y texlive-extra-utils')],
    win32: [],
  },
  imageProcessingInstalled: {
    darwin: [brew('brew install ghostscript graphicsmagick')],
    linux: [apt('sudo apt-get install -y ghostscript graphicsmagick')],
    win32: [scoop('scoop install ghostscript graphicsmagick')],
  },
};

/** Narrows a `DependencyInfo.key` to whether `DEPENDENCY_INSTALL_COMMANDS` has
 *  an entry for it — most `LatexSettingsStatus` keys (paths, `platform`,
 *  `latexWorkshopInstalled`) do not. */
export function hasInstallCommands(key: string): key is DependencyInstallKey {
  return Object.hasOwn(DEPENDENCY_INSTALL_COMMANDS, key);
}

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
