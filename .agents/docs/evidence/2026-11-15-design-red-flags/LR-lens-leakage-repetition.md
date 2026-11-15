# LR: information leakage and repetition (lens)

Read on `main` at `cb22acd`; lens over `packages/*/src` (harness, texra, llm, cli, desktop, extension, trace-viewer).

Method: three mechanical samples, then reading. (1) Same-named top-level
functions across files. (2) Regex and string literals that occur in two or
more files. (3) A window hash over normalized source lines (6 verbatim lines;
7 lines with identifiers erased) across all of `packages/*/src`. Sample (3)
found almost nothing: verbatim or shape-identical blocks across files are
gone from this tree. What is left is semantic repetition: the same rule
written differently in two places.

### LR-1: the desktop keeps its own list of macOS tool directories beside `commandDirs()`

- **Package:** desktop
- **Flags:** repetition (a fact with two owners); a rule decided per host
- **Evidence:** `packages/desktop/src/main/platform/pathFix.ts:3-11`
  `MACOS_PATH_ENTRIES` (`/Library/TeX/texbin`, `/opt/homebrew/bin`,
  `/usr/local/bin`, …) is prepended to `process.env.PATH` by
  `repairLaunchPath` (`:13-20`, one caller,
  `packages/desktop/src/main/platform/index.ts:21`). The app's owner of
  "where tools live when a GUI app did not inherit the shell profile" is
  `commandDirs()` (`packages/texra/src/platform/defaults/commandDirs.ts:76-93`),
  whose darwin list also has `/usr/texbin`, the MiKTeX bundle, `~/bin` and
  `~/.local/bin`. The extension extends its process PATH from that owner
  (`packages/extension/src/frontend/setup.ts:25-32`,
  `withExtendedPath({ PATH }, commandDirs())`), and the desktop's own pty host
  does too (`packages/desktop/src/main/desktopPtyHost.ts:119`). So in the
  desktop, a spawned terminal sees `~/.local/bin` and the main process's
  `process.env.PATH` does not; a directory added to `commandDirs` reaches
  two of the three PATH writers.
- **Better design:** `repairLaunchPath` is `fixPath()` followed by
  `process.env.PATH = withExtendedPath({ PATH: process.env.PATH }, commandDirs()).PATH`,
  the extension's three lines. The four system directories (`/usr/bin`,
  `/bin`, `/usr/sbin`, `/sbin`) are what `fix-path` restores.
- **Deleted:** `MACOS_PATH_ENTRIES`, the hand-written split/filter/join.
- **Size:** ~15 lines, 1 file.
- **Risk / owner decision:** none (PATH order changes: `commandDirs` first,
  as in the extension).
