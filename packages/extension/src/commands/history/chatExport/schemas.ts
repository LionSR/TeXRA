/**
 * Compatibility re-exports for chat export schemas.
 *
 * The provider-independent IR schemas (`ExportNode`, `UserPart`,
 * `ExportConfig`, `ChatExportInput`, `DocumentMeta`) are defined in
 * `@agent/export/schemas` and re-exported here so the command-layer
 * renderers and legacy imports don't pull in provider SDK types.
 */

export {
  ChatExportInputSchema,
  ExportConfigSchema,
  UserPartSchema,
  type ChatExportInput,
  type DocumentMeta,
  type ExportConfig,
  type ExportNode,
  type UserPart,
} from '@agent/export/schemas';
