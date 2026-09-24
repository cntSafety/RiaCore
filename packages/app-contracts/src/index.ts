/*
 * Copyright (c) Samir Sarkic and Simon Roth
 *
 * This file is part of RiaCore.
 *
 * RiaCore is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 */
export * from './result.js';
export * from './action-priority-types.js';
export * from './db.js';
export * from './workspace.js';
export * from './ipc.js';
export * from './worker-protocol.js';
export * from './import-types.js';
export * from './persistor-types.js';
export * from './provisioning-types.js';
export * from './profile-types.js';
export * from './graph-types.js';
export * from './metamodel-types.js';
export * from './safety-types.js';
export * from './safety-export-types.js';
export * from './check-types.js';
export * from './arxml-types.js';
export * from './diff-types.js';
export * from './diff-presentation.js';
export * from './cache-invalidation.js';
export * from './show-in-tree.js';
export * from './namespace-connection-types.js';
export * from './export-settings-types.js';
export * from './canvas-layout-types.js';
export * from './view-types.js';
export * from './presentation-types.js';
export * from './llm-types.js';
// Explicit named re-exports of runtime values from llm-types so Rollup's
// CJS static-analysis can resolve them through the compiled `dist/index.js`
// (the `export *` star re-export above carries types fine but compiles to
// `__exportStar(require('./llm-types.js'), exports)` for runtime values,
// which Rollup cannot trace statically).
export { SWC_COMPONENT_CONCEPTS, SYSML_ELEMENT_CONCEPTS } from './llm-types.js';
export { DEFAULT_AUTO_COMMIT_TEMPLATE } from './git-types.js';
export { resolveActionPriority } from './action-priority-types.js';
// Same rule for the diff presentation vocabulary: these are runtime values, so
// the `export *` above is not enough for a bundler to see them. Omitting any of
// them here produces `X is not a function` in the renderer at runtime while
// `tsc` and Vitest both pass — types resolve through the star, and Node's CJS
// `require` executes `__exportStar` happily; only static analysis cannot follow
// it. Enforced by `src/__tests__/runtime-export-coverage.test.ts`.
export {
  SECTION_CHIP_LABELS,
  SECTION_HEADING_LABELS,
  labelSectionChip,
  labelSectionHeading,
  isSafetyFamilyMetamodel,
  conceptTypeLabels,
  attributeKeyLabels,
  relationshipTypeLabels,
  labelConceptType,
  labelAttributeKey,
  labelRelationshipType,
  MAX_LCS_CELLS,
  diffWords,
  diffPropertyValues,
  splitChangedTextForDisplay,
} from './diff-presentation.js';
// The remaining runtime values of this package, for the same reason. These were
// previously reachable only through the star re-export — latent breakage waiting
// for the first bundled module to import one of them. (The renderer carries its
// own copy of `shouldBroadcast` in lib/cache-invalidation-subscriber.ts, which
// is very likely a workaround for exactly that.)
export { shouldBroadcast, broadcastPolicy } from './cache-invalidation.js';
export { resolveAttributeKey, resolveAttributeLabel } from './check-types.js';
export { IPC_CHANNELS } from './ipc.js';
export { WorkspaceConfigSchema } from './workspace.js';
export type {
  GitSemanticDiffParams,
  GitSemanticDiffResult,
  GitEnsureGitignoreResult,
  WorkspaceGitConfig,
  GitRepoStatus,
  GitFileStatus,
  CommitParams,
  CommitResult,
  BranchInfo,
  LogParams,
  CommitEntry,
  CommitLog,
  RemoteInfo,
  FetchParams,
  FetchResult,
  PullParams,
  PullResult,
  PushParams,
  PushResult,
  CheckoutTempParams,
  GitUserConfig,
  GitError,
  GitErrorKind,
} from './git-types.js';
