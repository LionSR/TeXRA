/**
 * The crash-point conformance suite over TeXRA's plugins (`texraPlugins`),
 * the list every TeXRA host composes its process from: a resume
 * from every commit point of one run.
 */
import { crashConformanceSuite } from '@test/support/crashConformance';

crashConformanceSuite(['resume']);
