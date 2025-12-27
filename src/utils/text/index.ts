// String utilities
export * from './stringUtils';

// XML utilities - new focused modules
export * from './xmlCdata';
export * from './xmlFormatDetection';
export * from './xmlConversion';
export * from './xmlExtraction';

// XML utilities - barrel export for backward compatibility
export * from './xmlUtils';
export { xmlUtils as default } from './xmlUtils';

// Text enhancement
export * from './textEnhancementUtils';
