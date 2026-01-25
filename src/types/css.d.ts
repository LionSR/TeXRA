/**
 * Type declarations for CSS imports.
 *
 * Supports Vite's ?inline suffix for importing CSS as string.
 * Webpack uses inlineCssLoader.js to achieve the same result.
 */

// CSS as string (Vite ?inline suffix)
declare module '*.css?inline' {
  const content: string;
  export default content;
}

// Standard CSS imports (Vite or webpack)
declare module '*.css' {
  const content: string;
  export default content;
}
