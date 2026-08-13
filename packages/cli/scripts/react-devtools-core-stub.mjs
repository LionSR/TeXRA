// No-op stub for `react-devtools-core`. Ink imports this package only when
// `DEV=true` to attach to a running React DevTools session — irrelevant for
// production CLI bundles. We alias to this file at build time (see
// build-bundle.mjs) so esbuild can resolve the static import without the
// real (heavy) devtools dep being installed.
const noop = () => {};
export default {
  initialize: noop,
  connectToDevTools: noop,
};
