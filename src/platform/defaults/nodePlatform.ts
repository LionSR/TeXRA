/**
 * The Node standard-library services every process serves once: the
 * filesystem, path, and child-process spawner. `installProcessRuntime` merges
 * this layer into every root's runtime, so a program that reads a file or
 * starts a child process takes the service from context instead of building a
 * Node layer of its own. Module paths, never the `@effect/platform-node`
 * barrel, so loading this pulls in only these three services.
 */
import * as NodeChildProcessSpawner from '@effect/platform-node/NodeChildProcessSpawner';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { type FileSystem, Layer, type Path } from 'effect';
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

export const nodePlatformServices: Layer.Layer<
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner
> = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
);
