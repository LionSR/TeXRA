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
export const LATEX_RECOMMENDED_SETTINGS = Object.freeze({
  outDir: Object.freeze({
    kind: 'scalar',
    key: 'latex-workshop.latex.outDir',
    value: '%DIR%/build/',
    name: 'LaTeX Output Directory',
    description:
      'Redirect compilation artifacts to a build/ subfolder, keeping your project root clean.',
  } as const),
  autoRevealExclude: Object.freeze({
    kind: 'object',
    key: 'explorer.autoRevealExclude',
    value: Object.freeze({ '**/build/': true } as const),
    name: 'Explorer Auto-Reveal Exclude',
    description:
      'Prevent the build/ folder from being auto-revealed in the Explorer sidebar.',
  } as const),
} as const satisfies Readonly<Record<string, LatexRecommendedSetting>>);

/** The key of one recommended setting. */
export type LatexRecommendedSettingField =
  keyof typeof LATEX_RECOMMENDED_SETTINGS;

/** Package managers TeXRA knows how to install dependencies with. */
export const SYSTEM_PACKAGE_MANAGERS = Object.freeze([
  'brew',
  'apt',
  'scoop',
] as const);

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
      '  brew install --cask mactex          (full MacTeX, ~4 GB)',
    win32:
      'MiKTeX: choose "Install missing packages on the fly" when prompted.\n' +
      'Or TeX Live: https://tug.org/texlive/',
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
 * What the toolchain health report (`latexToolchainHealth`, which
 * `texra doctor` prints) makes of one dependency. A missing `required` tool
 * fails the report, which is what sets the CLI's nonzero exit code; a missing
 * `optional` one only warns. `none` means the report does not probe the tool
 * at all, so it lists no row for it.
 *
 * Known residual, stated rather than hidden: `latexmk` is `required` even
 * though a pdflatex-only machine counts as having a compiler (the settings
 * view's TeX Distribution row says the same) and `compileLatex2Pdf` falls
 * back to a single pdflatex pass on it (degraded: bibliography,
 * cross-references, and index may be incomplete). So such a machine passes
 * the compiler check and still fails on the latexmk row. Demoting latexmk to
 * a warning changes the doctor's exit code for a real machine configuration,
 * which is a product decision, not a consolidation.
 */
type HealthRole =
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
  readonly health: HealthRole;
  readonly probe: ProbeRole;
  /**
   * True when `compileLatex2Pdf` can actually drive this compiler: it runs
   * `latexmk` and falls back to `pdflatex`. Nothing here can invoke `xelatex`
   * or `lualatex` and no setting selects a compiler, so they must not count
   * as "a compiler is available".
   */
  readonly drivesCompile?: true;
  /** Probed by the dependency banner (`missingDependencyTools`). */
  readonly core?: true;
}

/**
 * The one catalog of external LaTeX and image dependencies TeXRA runs, how
 * each is probed and installed, and what each one means to each consumer that
 * probes it. The runner (`@texra/utils/system/toolChecks`) and the one probe
 * (`probeLatexTools` in `@latex/latexToolchain`) read it, and so do the four
 * surfaces that report from that probe, none restating a name: the health
 * report (`latexToolchainHealth`, beside the probe), the setup assistant
 * (`probe_environment`), the settings view's LaTeX status
 * (`@texra/controllers/settingsView/LatexToolingController`), and the
 * dependency banner (`missingDependencyTools`, beside the probe).
 *
 * The order is the health report's row order, which `texra doctor` prints.
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
    health: { row: 'required', purpose: 'LaTeX build orchestration' },
    probe: 'required',
    drivesCompile: true,
  },
  {
    name: 'pdflatex',
    install: TEX_DISTRIBUTION_INSTALL,
    health: { row: 'optional', purpose: 'PDFLaTeX compiler' },
    probe: 'required',
    drivesCompile: true,
  },
  {
    name: 'xelatex',
    install: TEX_DISTRIBUTION_INSTALL,
    health: { row: 'optional', purpose: 'XeLaTeX compiler' },
    probe: 'none',
  },
  {
    name: 'lualatex',
    install: TEX_DISTRIBUTION_INSTALL,
    health: { row: 'optional', purpose: 'LuaLaTeX compiler' },
    probe: 'none',
  },
  {
    name: 'bibtex',
    install: TEX_DISTRIBUTION_INSTALL,
    health: { row: 'optional', purpose: 'BibTeX bibliography processing' },
    probe: 'none',
  },
  {
    name: 'biber',
    install: TEX_DISTRIBUTION_INSTALL,
    health: { row: 'optional', purpose: 'Biber bibliography processing' },
    probe: 'none',
  },
  {
    name: 'latexdiff',
    install: LATEXDIFF_INSTALL,
    health: { row: 'optional', purpose: 'LaTeX diff generation' },
    probe: 'required',
  },
  {
    name: 'latexdiff-vc',
    install: LATEXDIFF_INSTALL,
    health: { row: 'none' },
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
    health: { row: 'optional', purpose: 'LaTeX formatting' },
    probe: 'required',
    core: true,
  },
  {
    name: 'tex-fmt',
    install: { brew: 'tex-fmt', apt: 'tex-fmt', cargo: 'tex-fmt' },
    health: { row: 'none' },
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
    health: { row: 'none' },
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
    health: { row: 'none' },
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
    health: { row: 'none' },
    probe: 'required',
    core: true,
  },
  {
    // `latexdiff-vc` and the Overleaf clone run it; a missing git is
    // reported where they run it, not probed.
    name: 'git',
    label: 'Git',
    install: {
      brew: 'git',
      apt: 'git',
      scoop: 'git',
      url: {
        darwin: 'https://git-scm.com/downloads',
        linux: 'https://git-scm.com/downloads',
        win32: 'https://git-scm.com/downloads',
      },
    },
    health: { row: 'none' },
    probe: 'none',
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
    health: { row: 'none' },
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
    health: { row: 'none' },
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
        health: Object.freeze({ ...tool.health }),
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

type HealthEntry = Extract<
  CatalogEntry,
  { health: { row: 'required' | 'optional' } }
>;

/** A dependency the setup assistant and the settings view both probe. */
export type ProbedLatexTool = EntryWith<'required' | 'image'>['name'];

/** One of the interchangeable image tools. */
type ImageLatexTool = EntryWith<'image'>['name'];

/** A compiler `compileLatex2Pdf` can drive. */
type SupportedLatexCompiler = CompilerEntry['name'];

/**
 * The dependency set the setup assistant and the settings view probe: the
 * LaTeX toolchain plus both image-tool candidates. Wider than
 * {@link CORE_DEPENDENCY_TOOLS} on purpose: setup installs a whole toolchain,
 * while the banner names only what TeXRA's own features run.
 */
export const PROBED_LATEX_TOOLS: readonly ProbedLatexTool[] = Object.freeze(
  LATEX_TOOLS.filter(
    (tool): tool is EntryWith<'required' | 'image'> => tool.probe !== 'none',
  ).map((tool) => tool.name),
);

/**
 * The named tools the dependency banner probes, with the image tools: the
 * ones TeXRA's own features (formatting, figure conversion) run, whatever
 * toolchain compiles the document. Derived, not restated.
 */
export const CORE_DEPENDENCY_TOOLS: readonly CoreEntry['name'][] =
  Object.freeze(
    LATEX_TOOLS.filter((t): t is CoreEntry => 'core' in t).map((t) => t.name),
  );

/** The image tools; either one alone satisfies the image capability. */
export const IMAGE_LATEX_TOOLS: readonly ImageLatexTool[] = Object.freeze(
  LATEX_TOOLS.filter(
    (tool): tool is EntryWith<'image'> => tool.probe === 'image',
  ).map((tool) => tool.name),
);

/**
 * What the dependency banner says TeXRA cannot do without each tool it
 * probes, completing "TeXRA can't …". Keyed by the catalog, so a new core
 * or image tool fails the type check until it says what it is for.
 */
export const DEPENDENCY_USE: Readonly<
  Record<CoreEntry['name'] | ImageLatexTool, string>
> = Object.freeze({
  latexindent: 'format .tex files',
  perl: 'run latexindent',
  gs: 'turn PDF figures into images',
  gm: 'turn PDF figures into images',
  magick: 'turn PDF figures into images',
});

/**
 * How user-facing output names the image capability when neither candidate is
 * installed: one entry, not two, because either tool satisfies it.
 */
export const IMAGE_TOOL_LABEL = 'gm/magick';

const IMAGE_TOOL_NAMES: ReadonlySet<string> = new Set(IMAGE_LATEX_TOOLS);

/** A probed tool that is missing. */
interface MissingLatexTool<T extends string> {
  readonly name: T;
  /** One of the image tools, any one of which would do. */
  readonly interchangeable: boolean;
}

/**
 * The missing tools among `probed`. Either image tool satisfies the image
 * capability, so the image tools are missing only when none of them is
 * installed, and then all are reported, marked interchangeable.
 */
export function missingLatexTools<T extends string>(
  probed: readonly { readonly name: T; readonly installed: boolean }[],
): MissingLatexTool<T>[] {
  const missing = probed
    .filter(({ name, installed }) => !installed && !IMAGE_TOOL_NAMES.has(name))
    .map(({ name }) => ({ name, interchangeable: false }));
  const images = probed.filter(({ name }) => IMAGE_TOOL_NAMES.has(name));
  if (images.length > 0 && !images.some(({ installed }) => installed)) {
    missing.push(
      ...images.map(({ name }) => ({ name, interchangeable: true })),
    );
  }
  return missing;
}

/** A dependency the toolchain health report lists. */
type HealthLatexToolName = HealthEntry['name'];

/** What one dependency means to the toolchain health report. */
export interface HealthLatexTool {
  /** The binary name; `texra doctor`'s row id is `latex.<name>`. */
  readonly name: HealthLatexToolName;
  /** A missing required tool fails the report. */
  readonly required: boolean;
  /** What the tool does, which a row shows when it is installed. */
  readonly purpose: string;
}

/** The dependencies the toolchain health report lists, in row order. */
export const HEALTH_LATEX_TOOLS: readonly HealthLatexTool[] = Object.freeze(
  LATEX_TOOLS.filter(
    (tool): tool is HealthEntry => tool.health.row !== 'none',
  ).map((tool) =>
    Object.freeze({
      name: tool.name,
      required: tool.health.row === 'required',
      purpose: tool.health.purpose,
    }),
  ),
);

/**
 * The LaTeX-to-PDF compilers TeXRA can actually drive. Single source for that
 * answer (the health report, the compile option enum, and the settings view's
 * TeX-distribution row), so none of them can disagree with the advice text.
 */
export const SUPPORTED_LATEX_COMPILERS: readonly SupportedLatexCompiler[] =
  Object.freeze(
    LATEX_TOOLS.filter(
      (tool): tool is CompilerEntry => 'drivesCompile' in tool,
    ).map((tool) => tool.name),
  );

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
export const LATEX_DEPENDENCIES = Object.freeze({
  compiler: Object.freeze({
    label: 'TeX Distribution',
    needs: Object.freeze([SUPPORTED_LATEX_COMPILERS] as const),
    installs: Object.freeze(['pdflatex'] as const),
  } as const),
  latexdiff: Object.freeze({
    label: 'latexdiff',
    needs: Object.freeze([Object.freeze(['latexdiff'] as const)] as const),
    installs: Object.freeze(['latexdiff'] as const),
  } as const),
  latexindent: Object.freeze({
    label: 'latexindent',
    needs: Object.freeze([
      Object.freeze(['latexindent'] as const),
      Object.freeze(['perl'] as const),
    ] as const),
    installs: Object.freeze(['latexindent', 'perl'] as const),
  } as const),
  texcount: Object.freeze({
    label: 'TeXcount',
    needs: Object.freeze([Object.freeze(['texcount'] as const)] as const),
    installs: Object.freeze(['texcount'] as const),
  } as const),
  image: Object.freeze({
    label: 'Image Processing',
    needs: Object.freeze([
      Object.freeze(['gs'] as const),
      IMAGE_LATEX_TOOLS,
    ] as const),
    installs: Object.freeze(['gs', 'gm'] as const),
  } as const),
} as const satisfies Readonly<
  Record<
    string,
    {
      readonly label: string;
      readonly needs: readonly (readonly ProbedLatexTool[])[];
      readonly installs: readonly LatexToolName[];
    }
  >
>);

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
interface InstallCommand {
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
 * other ways in and notes, then the command that checks each one. The check
 * names the tools asked about and a new terminal, which every host has: an
 * installer's PATH change does not reach a shell already open.
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
  const checks = tools.map((tool) => {
    const { alternates, versionArgs } = LATEX_TOOL_ENTRIES[tool];
    // Ghostscript's Windows builds do not ship as `gs`.
    const binary = platform === 'win32' ? (alternates?.[0] ?? tool) : tool;
    return `  ${binary} ${(versionArgs ?? ['--version']).join(' ')}`;
  });
  sections.push(
    `After installing, verify in a new terminal:\n${checks.join('\n')}`,
  );
  return Object.freeze({ guide: sections.join('\n\n'), command });
}

// ============================================================
// Utility functions
// ============================================================
