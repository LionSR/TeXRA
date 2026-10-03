/**
 * The crash-point conformance suite over the harness's built-ins alone
 * (`harnessBuiltins.all`), the list an embedder starts from.
 */
import '@test/support/builtinSessionGraphTestSetup';

import { crashConformanceSuite } from '@test/support/crashConformance';

crashConformanceSuite('harness built-ins');
