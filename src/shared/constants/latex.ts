/** Extension ID for the LaTeX Workshop VS Code extension. */
export const LATEX_WORKSHOP_EXT_ID = 'James-Yu.latex-workshop';

/** Supported platform keys for install guides. */
export type Platform = 'darwin' | 'win32' | 'linux';

// ============================================================
// Install guide builders
// ============================================================

type Guide = Record<Platform, string>;

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
  const platforms: Platform[] = ['darwin', 'linux', 'win32'];
  return Object.fromEntries(
    platforms.map((p) => {
      // Extract just the install command (first paragraph) from each guide
      const body = sections
        .map(([label, g]) => {
          const command = g[p].split('\n\n')[0].split('\n  ')[1];
          return `${label}:\n  ${command}`;
        })
        .join('\n\n');
      // Append a single Homebrew note for macOS instead of repeating per-section
      return [
        p,
        p === 'darwin'
          ? body + '\n\n"brew" requires Homebrew (https://brew.sh).'
          : body,
      ];
    }),
  ) as Guide;
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
    'Install MacTeX (recommended):\n' +
    '  brew install --cask mactex\n\n' +
    '"brew" requires Homebrew (https://brew.sh), a free\n' +
    'macOS package manager. Or download MacTeX directly from:\n' +
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
  /** Whether the command requires sudo (used to decide button behaviour). */
  readonly requiresSudo: boolean;
  /** The package manager the command targets (null = direct download / manual). */
  readonly packageManager: 'brew' | 'apt' | null;
}

/**
 * Per-dependency install commands keyed by `DependencyInfo.key`.
 *
 * A `null` entry means there is no single-command install for that
 * platform (e.g. Windows usually requires a manual download).
 */
export const DEPENDENCY_INSTALL_COMMANDS: Record<
  string,
  Record<Platform, InstallCommand | null>
> = {
  texDistributionInstalled: {
    darwin: {
      command: 'brew install --cask mactex',
      requiresSudo: false,
      packageManager: 'brew',
    },
    linux: {
      command: 'sudo apt-get install -y texlive-full',
      requiresSudo: true,
      packageManager: 'apt',
    },
    win32: null,
  },
  latexdiffInstalled: {
    darwin: {
      command: 'brew install latexdiff',
      requiresSudo: false,
      packageManager: 'brew',
    },
    linux: {
      command: 'sudo apt-get install -y latexdiff',
      requiresSudo: true,
      packageManager: 'apt',
    },
    win32: null,
  },
  latexindentInstalled: {
    darwin: {
      command: 'brew install latexindent',
      requiresSudo: false,
      packageManager: 'brew',
    },
    linux: {
      command: 'sudo apt-get install -y texlive-extra-utils perl',
      requiresSudo: true,
      packageManager: 'apt',
    },
    win32: null,
  },
  texcountInstalled: {
    darwin: {
      command: 'brew install texcount',
      requiresSudo: false,
      packageManager: 'brew',
    },
    linux: {
      command: 'sudo apt-get install -y texlive-extra-utils',
      requiresSudo: true,
      packageManager: 'apt',
    },
    win32: null,
  },
  imageProcessingInstalled: {
    darwin: {
      command: 'brew install ghostscript graphicsmagick',
      requiresSudo: false,
      packageManager: 'brew',
    },
    linux: {
      command: 'sudo apt-get install -y ghostscript graphicsmagick',
      requiresSudo: true,
      packageManager: 'apt',
    },
    win32: null,
  },
};

// ============================================================
// Utility functions
// ============================================================

/**
 * Normalize a raw platform string to one of the three supported values.
 * Falls back to 'linux' for unrecognized platforms (e.g. 'freebsd').
 */
export function normalizePlatform(raw: string): Platform {
  return raw === 'darwin' || raw === 'win32' ? raw : 'linux';
}

/**
 * Select the install guide for the given platform.
 * Falls back to linux if the platform is unrecognized.
 */
export function getInstallGuide(guide: Guide, platform: string): string {
  return guide[normalizePlatform(platform)] ?? guide.linux;
}
