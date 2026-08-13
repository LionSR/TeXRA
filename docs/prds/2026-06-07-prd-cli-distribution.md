---
created: 2026-06-07
updated: 2026-06-07
---

# PRD: TeXRA CLI Distribution (Homebrew + native binary)

**Status:** PENDING — approach undecided. Fact-check only; do NOT implement.
**Owner:** TBD
**Date:** 2026-06-07
**Branch:** `main`
**Companion to:** [`2026-05-04-prd-cli-app.md`](./2026-05-04-prd-cli-app.md)

> **Pending decision.** This document records the distribution options and a
> recommendation, but the path has not been chosen. It exists to be **fact-checked**
> (are the claims about npm formulas, Homebrew casks, Node SEA, and the Claude
> Code / Codex playbook accurate?), not actioned. No tap, formula, cask, CI action,
> or binary build should be created off this PRD until a tier is approved.

## 1. Summary

The `texra` CLI ships today as an npm package (`@texra-ai/cli`). This PRD covers how
to broaden distribution, specifically how to get it onto Homebrew, and whether to
ship a native binary that runs without Node installed.

The decision is a **tier choice**, not a single path:

- **Tier 1 (entry, ready today).** Keep the npm package as the source of truth and
  add a Homebrew **formula** that installs it via `npm`, with `depends_on "node"`.
  One small Ruby file plus one CI action; nothing in the product changes. This is
  shippable in an afternoon.
- **Tier 2 (full, matches Claude Code / Codex).** Compile the CLI to a per-platform
  **native binary**, distribute it as a Homebrew **cask** (not a formula), keep the
  npm channel working by turning the npm package into a thin per-platform binary
  shim, and offer a `curl | bash` installer. No `node` dependency, faster startup,
  but a real build matrix plus asset-embedding work.

Recommendation: **ship Tier 1 now, treat Tier 2 as a follow-up** gated on real
demand (complaints about needing Node, or startup cost). The two tiers are
additive: Tier 1's tap and release automation carry forward into Tier 2.

## 2. Goals

- Let macOS/Linux users install with a package manager: `brew install texra`.
- Keep updates automated so the Homebrew artifact trails an npm release by at most
  one auto-generated PR. No hand-edited formulas per release.
- Preserve the existing `npm i -g @texra-ai/cli` command and user-facing behavior.
- Keep headless parity sacred: distribution changes must not alter `texra run`,
  `--print`, or `--output-format json|ndjson` behavior.

## 3. Non-goals

- Submitting to `homebrew-core` (Homebrew's central repo). Rejected for now: it has
  notability bars, requires an SPDX license (our `package.json` declares
  `SEE LICENSE IN LICENSE.txt`, which they reject), and they own the release
  cadence. A self-owned tap is the right primitive.
- Windows package managers (winget, Scoop, Chocolatey). Out of scope here; the
  per-platform binary work in Tier 2 makes them cheap later.
- Linux distro packaging (apt, dnf, AUR). Out of scope.

## 4. Current state (grounded in the codebase, June 2026)

- **Package:** `@texra-ai/cli`, v0.38.6 on npm (local tree at 0.38.7), bin name
  `texra`, `engines.node >= 22.9.0`, `publishConfig.access: public`.
- **Artifact:** the published `0.38.6` tarball contains a single esbuild bundle
  `dist/bin/texra.js` (8,989,261 bytes, `format: 'esm'`, `target: 'node20'`,
  minified) plus `dist/resources/` (142,193 bytes: agents, docs, templates,
  tool-use agents). Reproduced with
  `npm pack @texra-ai/cli@0.38.6 --json`; packed tarball size is 2,648,694 bytes.
- **Zero runtime dependencies.** `package.json` has no `dependencies`, only
  `devDependencies`. `node-pty` (the one native module) is a **test-harness-only**
  dep used by `validate-run.mjs` / `validate-tui.mjs`; it is not in the shipped
  bundle. This makes the CLI SEA-eligible and trivial to wrap in a formula.
- **Resource resolution is filesystem-anchored.** `src/runtime/resourcesPath.ts`
  finds `dist/resources` by walking up from `import.meta.url` to the `cli` package
  dir. All candidates are `import.meta.url`-relative; **there is no
  `process.execPath`-anchored candidate and no embedded-asset branch.** This is the
  load-bearing runtime code change Tier 2 requires; the binary build also needs the
  CJS bundle target described in §8.1.
- **Public repo:** `github.com/texra-ai/texra-issues`. Proposed tap:
  `texra-ai/homebrew-tap` (referenced by users as `texra-ai/tap`).
- **Published tarball coordinates** (for the Tier 1 formula):
  - url: `https://registry.npmjs.org/@texra-ai/cli/-/cli-0.38.6.tgz`
  - sha256: `aab274196ab5b995ebc4165a97413b851142e6b9e6ac16796dea619520f6b9f8`

## 5. How the reference CLIs do it

Both Claude Code and Codex converged on the **same playbook**: build a native
binary once per platform, then fan it out over three parallel channels off the same
artifacts.

|                  | Claude Code                                                                                             | Codex                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Real artifact    | Native binary, **Bun-compiled** (`bun run build.ts`, `engines.bun >=1.2.0`)                             | Native binary, **Rust** (rewritten from the old TS CLI) |
| Native installer | `curl -fsSL https://claude.ai/install.sh \| bash` (primary, auto-updates)                               | `curl -fsSL https://chatgpt.com/codex/install.sh \| sh` |
| Homebrew         | **Casks**: `claude-code` (stable) + `claude-code@latest` (bleeding edge)                                | **Cask**: `brew install --cask codex`                   |
| npm              | `@anthropic-ai/claude-code` now _delivers the binary_ via per-platform optional deps + postinstall link | `@openai/codex`, same shim pattern                      |

Three takeaways that shape this PRD:

1. **Homebrew for a prebuilt binary is a cask, not a formula.** A formula is meant to
   build from source; a cask installs a precompiled artifact. Tier 1's npm-backed
   formula is the entry-tier compromise; Tier 2 uses a cask for the macOS binary.
2. **npm stays alive as a binary delivery vector.** The npm package stops _being_ the
   app and instead declares per-platform packages (e.g.
   `@texra-ai/cli-darwin-arm64`) as `optionalDependencies`; npm installs only the
   matching one and a `postinstall` symlinks it onto `PATH`. This is the exact trick
   esbuild, Biome, and swc use. It lets `npm i -g` keep working while shipping a
   binary.
3. **Neither auto-updates via Homebrew.** Casks need `brew upgrade`. That is why both
   vendors push the `curl | bash` installer as the primary, self-updating channel.

## 6. Recommended approach

### Phase 0 — Tier 1: npm-backed formula (ship now)

1. Create the tap repo `texra-ai/homebrew-tap` (the `homebrew-` prefix is mandatory).
2. Add `Formula/texra.rb` (see Appendix A) pointing at the npm registry tarball.
   Because there are zero runtime deps, `npm install` inside Homebrew's sandbox needs
   no network.
3. Add a `livecheck` block so `brew livecheck` / `brew bump` can detect new versions.
4. Wire release automation (see §7) so each `npm publish` opens a formula-bump PR.

Outcome: `brew tap texra-ai/tap && brew install texra`. Updates are one `url` +
one `sha256`, fully automated. Cost: tiny `node` dependency pulled by Homebrew,
runs on Homebrew's Node.

### Phase 1 — Tier 2: native binary (follow-up, demand-gated)

Only if "needs Node" or cold-start becomes a real complaint. Work items:

1. Add a CJS bundle target (esbuild `format: 'cjs'`) for SEA, which executes its
   entry as CommonJS (§8.1).
2. Add an embedded-asset branch to `resourcesPath.ts` (§8.3) reading via
   `node:sea` `getAsset()`.
3. Build per-platform binaries in a CI matrix (§8.2), codesign and notarize on
   macOS, attach to a GitHub release.
4. Add a macOS Homebrew **cask** that fans out by Apple Silicon vs Intel release
   assets. Linux release assets are still used by the npm shim and optional
   `curl | bash` installer, not by Homebrew casks.
5. Convert the npm package to the per-platform optionalDependencies shim so
   `npm i -g` remains the same install command and exposes the same `texra` binary
   behavior, even though the tarball layout changes.
6. Optionally add a `curl | bash` installer.

## 7. Keeping it updated (automation)

Standard practice for a self-owned tap is to self-trigger Homebrew's built-in
`brew bump-formula-pr` from the release pipeline. Do not hand-edit formulas.

- **Tier 1:** add `dawidd6/action-homebrew-bump-formula` (wraps `brew
bump-formula-pr`) to the release/publish job **after** `npm publish` succeeds. It
  must read the just-published npm version, not the follow-up workspace version bump,
  then compute the new url + sha256 and open a PR on the tap. With a tap-scoped PAT
  it can push directly and auto-merge.
- **Tier 2:** the cask + multi-platform binaries are best generated by **GoReleaser**
  (its `homebrew_casks` section plus the `prebuilt` builder for non-Go binaries) or,
  more lightly, `Justintime50/homebrew-releaser`. Both regenerate and push the
  cask/formula from release assets, so no Ruby is hand-edited.

Detection: a `livecheck` block keyed on the npm registry lets `brew bump` and the
bump action see new versions. (homebrew-core has an autobump bot that watches
livecheck; on a self-owned tap, the release pipeline plays that role.)

## 8. Tier 2 technical notes

### 8.1 Why Node SEA over `bun --compile`

Node SEA (Single Executable Applications) is the first-party Node feature: it copies
the host `node` binary and injects the app + assets as an embedded blob (via
`postject`), producing an ~80-110 MB executable that runs the blob instead of acting
like `node`. It is the **lowest-risk** binary path for TeXRA because the runtime
stays Node, so the ink TUI, fs access, and platform adapters behave identically to
today. Claude Code uses `bun --compile`, but only because it is a Bun app end to
end; adopting it here would mean revalidating the whole TUI under the Bun runtime.

Caveats:

- SEA executes its entry as **CommonJS**. The current bundle is ESM; Tier 2 adds a
  `format: 'cjs'` esbuild target.
- SEA **does not cross-compile**: each target binary is the host's `node`, so the CI
  matrix must run on macos-arm64, macos-x64, and Linux runners. (This is the main
  ergonomic loss versus `bun --compile`, which cross-compiles from one host.)
- macOS requires re-`codesign` after `postject` and notarization before cask
  distribution, or Gatekeeper can reject the quarantined binary.

### 8.2 Build matrix

| Target       | Runner                            |
| ------------ | --------------------------------- |
| darwin-arm64 | macos-14 (Apple silicon)          |
| darwin-x64   | macos-13 (Intel)                  |
| linux-x64    | ubuntu-latest                     |
| linux-arm64  | ubuntu-latest-arm (or QEMU/cross) |

Each job: bundle to CJS, generate SEA blob with embedded `dist/resources`, copy +
inject `node`, codesign (macOS), tar, upload as a release asset, emit sha256.

### 8.3 Resource embedding (the load-bearing change)

`resolveCliResourcesPath()` currently only finds `dist/resources` on a real
filesystem next to the bundle. In a single-file binary there is no such path. Tier 2
must do one of:

- **Embed** `resources/` into the SEA blob via the config `assets` map and add a
  branch to `resourcesPath.ts` that reads from `require('node:sea').getAsset(...)`
  when running as a SEA; or
- **Ship `resources/` next to the binary** in the Cellar and add a
  `process.execPath`-anchored candidate to `resourcesPath.ts` (today there is none).

Embedding is preferred for a true single-file binary. Either way this is real code,
and it is the only part no off-the-shelf tool can do for us.

## 9. Tooling so we do not reinvent the wheel

- **`brew bump-formula-pr`** (built into Homebrew) — the update primitive.
- **`dawidd6/action-homebrew-bump-formula`** — GitHub Action wrapping the above; the
  one thing Tier 1 needs.
- **`homebrew-npm-noob`** — one-shot formula generator from an npm package (barely
  needed given zero deps, but saves writing the first formula).
- **GoReleaser** (`homebrew_casks` + `prebuilt` builder) — turnkey for the Tier 2
  cask: builds archives from prebuilt binaries, generates the cask, cuts the GitHub
  release, pushes to the tap.
- **`Justintime50/homebrew-releaser`** — lighter Action that pushes a generated
  formula/cask from release assets.
- **Node SEA / `@yao-pkg/pkg` / `bun --compile`** — the compile-to-binary options
  (we pick SEA, §8.1).

## 10. Open questions and risks

- **License field.** `:cannot_represent` works on a tap but blocks homebrew-core.
  If core submission is ever wanted, the package needs an SPDX identifier.
- **Binary size.** A SEA binary is ~80-110 MB per platform versus the 2,648,694-byte
  npm tarball. Acceptable for a cask, but worth noting for release storage.
- **Two-channel drift in Tier 2.** Once npm delivers a binary via the shim, the
  optionalDependencies versions must stay lockstep with the main package version;
  the publish script must bump all platform packages together.
- **macOS notarization.** Treat notarization as required for cask distribution, not
  an optional polish step; otherwise quarantined downloads can fail Gatekeeper even
  when they are Developer ID signed.
- **Channels.** Claude Code ships stable + `@latest` casks. Decide whether TeXRA
  wants a single channel or a stable/edge split before building the cask.

## Appendix A — Tier 1 formula (ready to use)

```ruby
class Texra < Formula
  desc "AI-powered LaTeX research assistant for the terminal"
  homepage "https://texra.ai"
  url "https://registry.npmjs.org/@texra-ai/cli/-/cli-0.38.6.tgz"
  sha256 "aab274196ab5b995ebc4165a97413b851142e6b9e6ac16796dea619520f6b9f8"
  license :cannot_represent # package.json: "SEE LICENSE IN LICENSE.txt"

  livecheck do
    url "https://registry.npmjs.org/@texra-ai/cli/latest"
    regex(/"version"\s*:\s*"([^"]+)"/i)
  end

  depends_on "node@22"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/texra --version")
  end
end
```

## Appendix B — Tier 2 cask shape (illustrative)

```ruby
cask "texra" do
  version "0.39.0"
  on_arm do
    sha256 "..."
    url "https://github.com/texra-ai/texra-issues/releases/download/v#{version}/texra-darwin-arm64.tar.gz"
  end
  on_intel do
    sha256 "..."
    url "https://github.com/texra-ai/texra-issues/releases/download/v#{version}/texra-darwin-x64.tar.gz"
  end

  name "TeXRA CLI"
  homepage "https://texra.ai"

  binary "texra"
end
```
