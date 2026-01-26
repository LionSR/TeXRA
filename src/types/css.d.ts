/**
 * Type declarations for CSS and font imports.
 *
 * Supports Vite's ?inline suffix for importing CSS as string.
 * Webpack uses type: 'asset/source' to achieve the same result.
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

// Font imports - returns URL (or base64 data URI if inlined)
declare module '*.ttf' {
  const url: string;
  export default url;
}

declare module '*.woff' {
  const url: string;
  export default url;
}

declare module '*.woff2' {
  const url: string;
  export default url;
}
