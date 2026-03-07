/** LaTeX template imports — loaded as text by esbuild's text loader. */
declare module '*.tex' {
  const content: string;
  export default content;
}
