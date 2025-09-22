// File access tracking helpers are intentionally disabled.
//
// The previous implementation kept a Set of read files at the module level so
// we could verify that edit operations inspected the latest file contents.
// However, that state persisted across multiple agent runs and leaked between
// unrelated sessions. Until the tool runtime exposes lifecycle hooks we can use
// to scope that state per session, we leave this module as a placeholder and
// rely on documentation and error messaging to encourage agents to read files
// before editing them.
//
// When session-scoped tracking becomes feasible, reintroduce the helpers here
// so tools can enforce the "read before write" contract without bleeding state
// across runs.
export {};
