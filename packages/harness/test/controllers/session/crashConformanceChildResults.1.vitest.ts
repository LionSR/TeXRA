/**
 * The crash-point conformance suite over the harness's built-ins: a child's
 * result read once across a crash, shard 1 of 3, with one job's appends.
 */
import { crashConformanceSuite } from '@test/support/crashConformance';

crashConformanceSuite(['child-results'], { index: 0, count: 3 });
