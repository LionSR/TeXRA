export const esmCjsGlobalsBanner = [
  'import { createRequire as __texraCreateRequire } from "node:module";',
  'import { dirname as __texraDirname } from "node:path";',
  'import { fileURLToPath as __texraFileURLToPath } from "node:url";',
  'const require = __texraCreateRequire(import.meta.url);',
  'const __filename = __texraFileURLToPath(import.meta.url);',
  'const __dirname = __texraDirname(__filename);',
].join('\n');
