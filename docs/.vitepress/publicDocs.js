// Single source of truth for the docs publishing boundary.
//
// This is imported by `.vitepress/config.js` (as VitePress `srcExclude`) and by
// `../scripts/check-root-docs.mjs` (the CI gate that fails a PR introducing an
// unclassified root-level doc). Keep this file dependency-free — no imports —
// so the gate can run with bare Node, without installing the docs sub-project.
//
// Intended public root surface for texra.ai. VitePress is opt-out: it publishes
// root markdown files and content directories unless `srcExclude` blocks them.
// The boundary gate treats `publicRootDocs` / `publicRootDirs` as the explicit
// public surface and `srcExclude` as internal. Static assets under public/ are
// served as-is and are fine to expose.

// Root-level markdown intentionally published to texra.ai. `changelog.md` and
// `terms.md` are generated into the docs root at build time by the
// `sync-content` script (from repo-root CHANGELOG.md / TERMS_OF_SERVICE.md) and
// are .gitignored; they are listed here so the boundary gate does not flag them
// as unclassified in a checkout where the build has run.
export const publicRootDocs = [
  'index.md',
  'launch.md',
  'providers.md',
  'changelog.md',
  'terms.md',
];

// Root-level directories whose contents are published (minus any per-page
// exclusions in `srcExclude`, e.g. the guide/desktop* beta pages).
export const publicRootDirs = ['guide'];

// Sources excluded from the public build. Root-level *.md entries are internal
// docs; `name/**` entries exclude whole internal directories.
export const srcExclude = [
  'README.md',
  'guide/desktop.md',
  'guide/desktop-migration.md',
  'design/**',
  'dev/**',
  'architecture/**',
  'prds/**',
  'proposals/**',
  'reference/**',
  'supabase/**',
  'node_modules/**',
];
