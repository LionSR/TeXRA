/**
 * The crash-point conformance suite over TeXRA's plugins (`texraPlugins`),
 * the list every TeXRA host composes its process from.
 */
import '@test/support/sessionGraphTestSetup';

import { crashConformanceSuite } from '@test/support/crashConformance';

crashConformanceSuite('TeXRA plugins');
