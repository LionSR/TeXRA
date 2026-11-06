/**
 * The crash-point conformance suite over the harness's built-ins: a resume
 * from every commit point of one run, shard 2 of 4.
 */
import { crashConformanceSuite } from '@test/support/crashConformance';

crashConformanceSuite(['resume'], { index: 1, count: 4 });
