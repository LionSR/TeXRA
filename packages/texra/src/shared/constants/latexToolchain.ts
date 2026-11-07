/**
 * LaTeX toolchain constants: the recommended LaTeX Workshop settings, the
 * dependency catalog with each tool's install record, the dependencies the
 * LaTeX tab reports, and the one renderer of install advice.
 */

import type { OsPlatform } from '@texra/shared/osPlatform';

/** Extension ID for the LaTeX Workshop VS Code extension. */
export const LATEX_WORKSHOP_EXT_ID = 'James-Yu.latex-workshop';

/**
 * A recommended VS Code setting: a scalar written as is, or an object merged
 * key-by-key into whatever the user already has set (rather than overwritten
 * wholesale).
 */
export type LatexRecommendedSetting = {
  readonly key: string;
  readonly name: string;
  readonly description: string;
} & (
  | { readonly kind: 'scalar'; readonly value: string }
  | {
      readonly kind: 'object';
      readonly value: Readonly<Record<string, boolean>>;
    }
);

/**
 * The VS Code settings the LaTeX page recommends, keyed as
 * `LatexSettingsStatus.editor.recommended` reports each one, in display
 * order. The extension's editor integration writes and inspects them; the
 * LaTeX tab renders them.
 */
export const LATEX_RECOMMENDED_SETTINGS = {
  outDir: {
    kind: 'scalar',
    key: 'latex-workshop.latex.outDir',
    value: '%DIR%/build/',
    name: 'LaTeX Output Directory',
    description:
      'Redirect compilation artifacts to a build/ subfolder, keeping your project root clean.',
  },
  autoRevealExclude: {
    kind: 'object',
    key: 'explorer.autoRevealExclude',
    value: { '**/build/': true },
    name: 'Explorer Auto-Reveal Exclude',
    description:
      'Prevent the build/ folder from being auto-revealed in the Explorer sidebar.',
  },
} as const satisfies Readonly<Record<string, LatexRecommendedSetting>>;

/** The key of one recommended setting. */
export type LatexRecommendedSettingField =
  keyof typeof LATEX_RECOMMENDED_SETTINGS;

/** Package managers TeXRA knows how to install dependencies with. */
export const SYSTEM_PACKAGE_MANAGERS = ['brew', 'apt', 'scoop'] as const;

export type SystemPackageManager = (typeof SYSTEM_PACKAGE_MANAGERS)[number];

// ============================================================
// Install records
// ============================================================

/**
 * How to install one tool, as data: its package for each package manager,
 * the other ways in, and notes. {@link installAdvice} renders it for one
 * platform, both as the guide a reader follows and as the command the LaTeX
 * tab copies or runs.
 */
interface InstallRecord {
  /** Homebrew formulae, on macOS. */
  readonly brew?: string;
  /** apt packages, on Linux. */
  readonly apt?: string;
  /** Scoop packages, on Windows. */
  readonly scoop?: string;
  /** The TeX package on Windows, through MiKTeX Console or `tlmgr`. */
  readonly tex?: string;
  /** A Cargo crate, on every platform. */
  readonly cargo?: string;
  /** A download page, per platform. */
  readonly url?: Partial<Record<OsPlatform, string>>;
  readonly notes?: Partial<Record<OsPlatform, string>>;
}

const TEX_DISTRIBUTION_INSTALL: InstallRecord = {
  brew: 'texlive',
  apt: 'texlive-full',
  scoop: 'miktex',
  url: {
    darwin: 'https://www.tug.org/mactex/mactex-download.html',
    win32: 'https://miktex.org/download',
  },
  notes: {
    darwin:
      'Alternatives:\n' +
      '  brew install --cask mactex-no-gui   (MacTeX without GUI apps)\n' +
      '  brew install --cask mactex          (full MacTeX, ~4 GB)\n\n' +
      'After installing, restart VS Code and verify by running\n' +
      '"pdflatex --version" in Terminal.',
    linux:
      'After installing, restart VS Code and verify by running\n' +
      '"pdflatex --version" in a terminal.',
    win32:
      'MiKTeX: choose "Install missing packages on the fly" when prompted.\n' +
      'Or TeX Live: https://tug.org/texlive/\n\n' +
      'After installing, restart VS Code and verify by running\n' +
      '"pdflatex --version" in Command Prompt.',
  },
};

const TEX_EXTRA = 'Part of most TeX Live distributions (texlive-extra-utils).';
const TEX_DIST = 'Part of most TeX Live distributions.';

const LATEXDIFF_INSTALL: InstallRecord = {
  brew: 'latexdiff',
  apt: 'latexdiff',
  tex: 'latexdiff',
  notes: {
    darwin: 'Also included with MacTeX (texlive-extra-utils).',
    linux: TEX_EXTRA,
    win32: TEX_EXTRA,
  },
};

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
 * What the setup assistant (`probe_environment`) and the
 * settings view's LaTeX tab make of one dependency. A `required` tool is
 * reported missing under its own name; the `image` tools are interchangeable,
 * so either one alone satisfies the image capability and both absent report a
 * single `gm/magick` entry; `none` means neither surface probes it.
 */
type ProbeRole = 'required' | 'image' | 'none';

interface LatexToolEntry {
  /** The binary name, probed as `<name> --version` or on PATH. */
  readonly name: string;
  /** How to install it, rendered by {@link installAdvice}. */
  readonly install: InstallRecord;
  /** The version arguments, when not `--version` (GraphicsMagick has none). */
  readonly versionArgs?: readonly string[];
  /**
   * Other names the binary ships as, probed in turn when `name` does not
   * answer: Ghostscript's Windows builds are `gswin64c` and `gswin32c`.
   */
  readonly alternates?: readonly string[];
  /** Display name for missing-dependency lists; defaults to the name. */
  readonly label?: string;
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
 * The one catalog of external LaTeX and image dependencies TeXRA runs, how
 * each is probed and installed, and what each one means to each consumer that
 * probes it. The runner (`@texra/utils/system/toolChecks`) and four surfaces
 * read it and none restates a name: the doctor probe (`@latex/latexToolchain`), the
 * setup assistant's (`@texra/tools/setup/toolProbing`), the settings view's LaTeX
 * status (`@texra/controllers/settingsView/LatexToolingController`), and the
 * dependency banner (`checkCoreDependencies` in
 * `packages/extension/src/progressView/checkCoreDependencies.ts`).
 *
 * The order is the doctor's row order, which is user-visible CLI output.
 *
 * Lives in `shared` rather than `tools` or `latex` because all three
 * subsystems consume it — and `tools` already depends on `latex`, so a
 * `latex`-side or `tools`-side home would create a cross-subsystem import
 * cycle (nothing checks that edge). Keep the tool descriptions in
 * `ProbeEnvironmentTool` aligned with the `required` and
 * `image` entries here — they appear verbatim in the LLM prompt.
 */
const LATEX_TOOLS = [
  {
    name: 'latexmk',
    install: {
      brew: 'latexmk',
      apt: 'latexmk',
      tex: 'latexmk',
      notes: { darwin: 'Also included with MacTeX.' },
    },
    doctor: { row: 'required', purpose: 'LaTeX build orchestration' },
    probe: 'required',
    drivesCompile: true,
  },
  {
    name: 'pdflatex',
    install: TEX_DISTRIBUTION_INSTALL,
    doctor: { row: 'optional', purpose: 'PDFLaTeX compiler' },
    probe: 'required',
    drivesCompile: true,
  },
  {
    name: 'xelatex',
    install: TEX_DISTRIBUTION_INSTALL,
    doctor: { row: 'optional', purpose: 'XeLaTeX compiler' },
    probe: 'none',
  },
  {
    name: 'lualatex',
    install: TEX_DISTRIBUTION_INSTALL,
    doctor: { row: 'optional', purpose: 'LuaLaTeX compiler' },
    probe: 'none',
  },
  {
    name: 'bibtex',
    install: TEX_DISTRIBUTION_INSTALL,
    doctor: { row: 'optional', purpose: 'BibTeX bibliography processing' },
    probe: 'none',
  },
  {
    name: 'biber',
    install: TEX_DISTRIBUTION_INSTALL,
    doctor: { row: 'optional', purpose: 'Biber bibliography processing' },
    probe: 'none',
  },
  {
    name: 'latexdiff',
    install: LATEXDIFF_INSTALL,
    doctor: { row: 'optional', purpose: 'LaTeX diff generation' },
    probe: 'required',
  },
  {
    name: 'latexdiff-vc',
    install: LATEXDIFF_INSTALL,
    doctor: { row: 'none' },
    probe: 'none',
  },
  {
    name: 'latexindent',
    install: {
      brew: 'latexindent',
      apt: 'texlive-extra-utils',
      tex: 'latexindent',
      notes: {
        darwin:
          'Also included with MacTeX. Requires Perl (pre-installed on macOS).',
        linux: 'Requires Perl.',
        win32: 'Also requires Perl (Strawberry Perl recommended).',
      },
    },
    doctor: { row: 'optional', purpose: 'LaTeX formatting' },
    probe: 'required',
    core: true,
  },
  {
    name: 'tex-fmt',
    install: { brew: 'tex-fmt', apt: 'tex-fmt', cargo: 'tex-fmt' },
    doctor: { row: 'none' },
    probe: 'none',
  },
  {
    name: 'texcount',
    install: {
      brew: 'texcount',
      apt: 'texlive-extra-utils',
      tex: 'texcount',
      notes: {
        darwin: 'Also included with MacTeX and most TeX Live distributions.',
        linux: TEX_DIST,
        win32: TEX_DIST,
      },
    },
    doctor: { row: 'none' },
    probe: 'required',
  },
  {
    name: 'perl',
    install: {
      apt: 'perl',
      url: { win32: 'https://strawberryperl.com/' },
      notes: {
        darwin:
          'Perl is pre-installed on macOS. If missing, reinstall via:\n  brew install perl',
      },
    },
    doctor: { row: 'none' },
    probe: 'required',
    core: true,
  },
  {
    name: 'gs',
    install: {
      brew: 'ghostscript',
      apt: 'ghostscript',
      scoop: 'ghostscript',
      url: {
        darwin: 'https://ghostscript.com/releases/gsdnld.html',
        win32: 'https://ghostscript.com/releases/gsdnld.html',
      },
    },
    alternates: ['gswin64c', 'gswin32c'],
    doctor: { row: 'none' },
    probe: 'required',
    core: true,
  },
  {
    name: 'gm',
    label: 'GraphicsMagick',
    install: {
      brew: 'graphicsmagick',
      apt: 'graphicsmagick',
      scoop: 'graphicsmagick',
      url: {
        darwin: 'http://www.graphicsmagick.org/download.html',
        win32: 'http://www.graphicsmagick.org/download.html',
      },
      notes: {
        darwin: 'ImageMagick (brew install imagemagick) works in its place.',
        linux:
          'ImageMagick (sudo apt-get install -y imagemagick) works in its place.',
        win32: 'ImageMagick works in its place.',
      },
    },
    versionArgs: ['version'],
    doctor: { row: 'none' },
    probe: 'image',
  },
  {
    name: 'magick',
    label: 'ImageMagick',
    install: {
      brew: 'imagemagick',
      apt: 'imagemagick',
      url: {
        darwin: 'https://imagemagick.org/script/download.php',
        win32: 'https://imagemagick.org/script/download.php',
      },
    },
    doctor: { row: 'none' },
    probe: 'image',
  },
] as const satisfies readonly LatexToolEntry[];

type CatalogEntry = (typeof LATEX_TOOLS)[number];

/** A tool TeXRA runs or probes: one catalog name. */
export type LatexToolName = CatalogEntry['name'];

/** Each catalog entry by its name: how the runner probes and installs it. */
// cast: the entries are keyed by every catalog name, one each.
export const LATEX_TOOL_ENTRIES = Object.freeze(
  Object.fromEntries(
    // Frozen through: the entries cross module boundaries, and an edited
    // install record would change what every later missing tool reports.
    // The records are frozen in place, so tools that share one still do.
    LATEX_TOOLS.map((tool: LatexToolEntry) => [
      tool.name,
      Object.freeze({
        ...tool,
        install: freezeInstall(tool.install),
        doctor: Object.freeze({ ...tool.doctor }),
        ...(tool.versionArgs && {
          versionArgs: Object.freeze([...tool.versionArgs]),
        }),
        ...(tool.alternates && {
          alternates: Object.freeze([...tool.alternates]),
        }),
      }),
    ]),
  ),
) as Readonly<Record<LatexToolName, LatexToolEntry>>;

function freezeInstall(record: InstallRecord): InstallRecord {
  if (record.url) Object.freeze(record.url);
  if (record.notes) Object.freeze(record.notes);
  return Object.freeze(record);
}

type EntryWith<Role extends ProbeRole> = Extract<CatalogEntry, { probe: Role }>;

type CompilerEntry = Extract<CatalogEntry, { drivesCompile: true }>;

type CoreEntry = Extract<CatalogEntry, { core: true }>;

type DoctorEntry = Extract<
  CatalogEntry,
  { doctor: { row: 'required' | 'optional' } }
>;

/** A dependency the setup assistant and the settings view both probe. */
type ProbedLatexTool = EntryWith<'required' | 'image'>['name'];

/** One of the interchangeable image tools. */
type ImageLatexTool = EntryWith<'image'>['name'];

/** A compiler `compileLatex2Pdf` can drive. */
type SupportedLatexCompiler = CompilerEntry['name'];

/**
 * The dependency set the setup assistant and the settings view probe: the
 * LaTeX toolchain plus both image-tool candidates. One spelling of that list;
 * the copies it replaces were kept in step by hand. Wider than
 * {@link CORE_DEPENDENCY_TOOLS} on purpose: setup installs a whole toolchain,
 * while the banner names only what TeXRA's own features run.
 */
export const PROBED_LATEX_TOOLS: readonly ProbedLatexTool[] =
  LATEX_TOOLS.filter(
    (tool): tool is EntryWith<'required' | 'image'> => tool.probe !== 'none',
  ).map((tool) => tool.name);

/**
 * The named tools the dependency banner probes, with the image tools: the
 * ones TeXRA's own features (formatting, figure conversion) run, whatever
 * toolchain compiles the document. Derived, not restated.
 */
export const CORE_DEPENDENCY_TOOLS: readonly CoreEntry['name'][] =
  LATEX_TOOLS.filter((t): t is CoreEntry => 'core' in t).map((t) => t.name);

/** The image tools; either one alone satisfies the image capability. */
export const IMAGE_LATEX_TOOLS: readonly ImageLatexTool[] = LATEX_TOOLS.filter(
  (tool): tool is EntryWith<'image'> => tool.probe === 'image',
).map((tool) => tool.name);

/**
 * What the dependency banner says TeXRA cannot do without each tool it
 * probes, completing "TeXRA can't …". Keyed by the catalog, so a new core
 * or image tool fails the type check until it says what it is for.
 */
export const DEPENDENCY_USE: Readonly<
  Record<CoreEntry['name'] | ImageLatexTool, string>
> = {
  latexindent: 'format .tex files',
  perl: 'run latexindent',
  gs: 'turn PDF figures into images',
  gm: 'turn PDF figures into images',
  magick: 'turn PDF figures into images',
};

/**
 * How user-facing output names the image capability when neither candidate is
 * installed: one entry, not two, because either tool satisfies it.
 */
export const IMAGE_TOOL_LABEL = 'gm/magick';

const IMAGE_TOOL_NAMES: ReadonlySet<string> = new Set(IMAGE_LATEX_TOOLS);

/** A probed tool that is missing. */
export interface MissingLatexTool<T extends string> {
  readonly name: T;
  /** One of the image tools, any one of which would do. */
  readonly interchangeable: boolean;
}

/**
 * The missing tools among `probed` (each tool with whether it is installed).
 * Either image tool satisfies the image capability, so the image tools are
 * missing only when none of them is installed, and then all are reported,
 * marked interchangeable.
 */
export function missingLatexTools<T extends string>(
  probed: readonly (readonly [T, boolean])[],
): MissingLatexTool<T>[] {
  const missing = probed
    .filter(([name, installed]) => !installed && !IMAGE_TOOL_NAMES.has(name))
    .map(([name]) => ({ name, interchangeable: false }));
  const images = probed.filter(([name]) => IMAGE_TOOL_NAMES.has(name));
  if (images.length > 0 && !images.some(([, installed]) => installed)) {
    missing.push(...images.map(([name]) => ({ name, interchangeable: true })));
  }
  return missing;
}

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
 * answer (the doctor probe, the compile option enum, and the settings view's
 * TeX-distribution row), so none of them can disagree with the advice text.
 */
export const SUPPORTED_LATEX_COMPILERS: readonly SupportedLatexCompiler[] =
  LATEX_TOOLS.filter(
    (tool): tool is CompilerEntry => 'drivesCompile' in tool,
  ).map((tool) => tool.name);

// ============================================================
// Install advice
// ============================================================

/** Official Homebrew one-liner install script. */
export const HOMEBREW_INSTALL_COMMAND =
  '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';

/** Official Scoop install commands (PowerShell). */
export const SCOOP_INSTALL_COMMAND =
  'Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser; irm get.scoop.sh | iex';

/**
 * The dependencies the settings view's LaTeX tab reports, each one a field
 * of `LatexSettingsStatus.installed`. `needs` is what makes it installed:
 * every group, by any one tool of the group. `installs` is what its install
 * advice installs.
 */
export const LATEX_DEPENDENCIES = {
  compiler: {
    label: 'TeX Distribution',
    needs: [SUPPORTED_LATEX_COMPILERS],
    installs: ['pdflatex'],
  },
  latexdiff: {
    label: 'latexdiff',
    needs: [['latexdiff']],
    installs: ['latexdiff'],
  },
  latexindent: {
    label: 'latexindent',
    needs: [['latexindent'], ['perl']],
    installs: ['latexindent', 'perl'],
  },
  texcount: {
    label: 'TeXcount',
    needs: [['texcount']],
    installs: ['texcount'],
  },
  image: {
    label: 'Image Processing',
    needs: [['gs'], IMAGE_LATEX_TOOLS],
    installs: ['gs', 'gm'],
  },
} as const satisfies Readonly<
  Record<
    string,
    {
      readonly label: string;
      readonly needs: readonly (readonly ProbedLatexTool[])[];
      readonly installs: readonly LatexToolName[];
    }
  >
>;

/** A dependency the LaTeX tab reports. */
export type LatexDependency = keyof typeof LATEX_DEPENDENCIES;

/** Where `brew install` comes from, said once per guide. */
const HOMEBREW_NOTE = '"brew" requires Homebrew (https://brew.sh).';

/** The package manager each platform's commands use. */
const PLATFORM_PACKAGE_MANAGER = {
  darwin: 'brew',
  linux: 'apt',
  win32: 'scoop',
} as const satisfies Record<OsPlatform, SystemPackageManager>;

const MANAGER_INSTALL: Record<SystemPackageManager, string> = {
  brew: 'brew install',
  apt: 'sudo apt-get install -y',
  scoop: 'scoop install',
};

/**
 * A concrete install command for a dependency on a given platform, which the
 * LaTeX tab copies or runs once its package manager is detected.
 */
export interface InstallCommand {
  /** The full shell command (e.g. "brew install ghostscript"). */
  readonly command: string;
  readonly packageManager: SystemPackageManager;
}

/** What {@link installAdvice} renders for one platform. */
export interface InstallAdvice {
  /** The steps to read, the text a missing tool reports. */
  readonly guide: string;
  /** One command over every package the platform's manager has for them,
   *  or null when it has none. */
  readonly command: InstallCommand | null;
}

/**
 * How to install `tools` together on `platform`, titled `label`: one command
 * over their packages for the platform's package manager, then each tool's
 * other ways in and notes.
 */
export function installAdvice(
  label: string,
  tools: readonly LatexToolName[],
  platform: OsPlatform,
): InstallAdvice {
  const manager = PLATFORM_PACKAGE_MANAGER[platform];
  // Tools that share a record (the TeX distribution's) say it once.
  const records = [
    ...new Map(
      tools.map((tool) => {
        const entry = LATEX_TOOL_ENTRIES[tool];
        return [entry.install, entry.label ?? tool] as const;
      }),
    ),
  ];
  const packages = [
    ...new Set(
      records.flatMap(([record]) => record[manager]?.split(' ') ?? []),
    ),
  ];
  const command =
    packages.length === 0
      ? null
      : Object.freeze({
          command: `${MANAGER_INSTALL[manager]} ${packages.join(' ')}`,
          packageManager: manager,
        });
  const sections = command ? [`Install ${label}:\n  ${command.command}`] : [];
  if (command?.packageManager === 'brew') sections.push(HOMEBREW_NOTE);
  for (const [record, name] of records) {
    if (platform === 'win32' && record.tex) {
      sections.push(
        `${name} with MiKTeX: open MiKTeX Console → Packages → search "${record.tex}" → Install\n` +
          `With TeX Live: tlmgr install ${record.tex}`,
      );
    }
    if (record.cargo) {
      sections.push(`Or ${name} via Cargo:\n  cargo install ${record.cargo}`);
    }
    const url = record.url?.[platform];
    if (url) sections.push(`Or download ${name}:\n  ${url}`);
    const notes = record.notes?.[platform];
    if (notes) sections.push(notes);
  }
  return Object.freeze({ guide: sections.join('\n\n'), command });
}

// ============================================================
// Utility functions
// ============================================================
