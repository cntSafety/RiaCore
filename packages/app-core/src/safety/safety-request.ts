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
import type { ServiceDependencies } from '../dispatch/types.js';
import { createCommandDispatcher } from '../dispatch/command-dispatcher.js';
import { createInstanceService } from '../namespaces/instance-service.js';
import { createSafetyCommands } from './safety-commands.js';
import { createPersistorService } from '../persistor/persistor.js';
import { beginAtomicPublication, recoverAtomicPublication } from '../persistor/atomic-publication.js';
import { verifySafetySnapshot } from '../persistor/verify-safety-snapshot.js';
import { assertNoSnapshotDrift, clearBaseline, stampBaseline } from '../workspace/snapshot-baseline.js';
import { readSafetyRequestReceipt, requestDigest, requestKey } from './request-receipts.js';
import type { IDbModule } from '../db/db-module.js';

export interface SafetyOperation { id?: string; channel: string; payload?: Record<string, unknown> }
export interface SafetyOperationResult { index: number; id?: string; channel: string; result: unknown }
export interface SafetyRequestResult {
  schemaVersion: 1;
  ok: boolean;
  changesCommitted?: boolean;
  results?: SafetyOperationResult[];
  error?: { code: string; message: string; operationId?: string; index?: number };
}
// All current safety graph handlers use only dbModule, instanceService and
// safetyCommands. Filesystem report exports are deliberately outside this scope.
export const atomicSafetyChannels: readonly string[] = [
  'safety.getMalfunctions',
  'safety.getMalfunction',
  'safety.createMalfunction',
  'safety.updateMalfunction',
  'safety.deleteMalfunction',
  'safety.attachOccursAt',
  'safety.detachOccursAt',
  'safety.moveOccursAt',
  'safety.addPropagation',
  'safety.removePropagation',
  'safety.getPropagations',
  'safety.getPropagationsForComponent',
  'safety.createRiskRating',
  'safety.getRiskRating',
  'safety.updateRiskRating',
  'safety.deleteRiskRating',
  'safety.createSafetyTask',
  'safety.linkSafetyTaskToFm',
  'safety.unlinkSafetyTaskFromFm',
  'safety.getSafetyTasks',
  'safety.getMalfunctionForTask',
  'safety.getMalfunctionForRiskRating',
  'safety.getMalfunctionForReviewItem',
  'safety.getAllSafetyTasks',
  'safety.updateSafetyTask',
  'safety.deleteSafetyTask',
  'safety.createFunctionalInsufficiency',
  'safety.linkFunctionalInsufficiencyToFm',
  'safety.unlinkFunctionalInsufficiencyFromFm',
  'safety.getFunctionalInsufficiencies',
  'safety.getAllFunctionalInsufficiencies',
  'safety.getMalfunctionsForFunctionalInsufficiency',
  'safety.updateFunctionalInsufficiency',
  'safety.deleteFunctionalInsufficiency',
  'safety.createTriggeringCondition',
  'safety.linkTriggeringConditionToFm',
  'safety.unlinkTriggeringConditionFromFm',
  'safety.getTriggeringConditions',
  'safety.getAllTriggeringConditions',
  'safety.getMalfunctionsForTriggeringCondition',
  'safety.updateTriggeringCondition',
  'safety.deleteTriggeringCondition',
  'safety.createRequirement',
  'safety.getRequirement',
  'safety.getRequirements',
  'safety.unlinkRequirementFromFm',
  'safety.updateRequirement',
  'safety.deleteRequirement',
  'safety.createSafetyNote',
  'safety.getSafetyNote',
  'safety.getSafetyNotes',
  'safety.updateSafetyNote',
  'safety.deleteSafetyNote',
  'safety.createReviewItem',
  'safety.getReviewItem',
  'safety.getReviewItems',
  'safety.getAllReviewItems',
  'safety.updateReviewItem',
  'safety.deleteReviewItem',
  'safety.getMalfunctionsForElement',
  'safety.getMalfunctionsForElements',
  'safety.getRequirementsForFm',
  'safety.getMalfunctionsForRequirement',
  'safety.linkRequirementToFm',
  'safety.linkDirectRequirementToFm',
  'safety.unlinkDirectRequirementFromFm',
  'safety.getDirectRequirementsForFm',
  'safety.searchRequirementsAcrossNamespaces',
  'safety.getNotesForFm',
  'safety.createNoteForFm',
  'safety.getNotesForElement',
  'safety.createNoteForElement',
  'safety.getNoteParent',
  'safety.previewDeleteImpact',
  'safety.getInstance',
  'safety.getRelationships',
  'safety.getAggregatedRelationships',
  'safety.getInstanceByUuid',
  'safety.createTag',
  'safety.getTag',
  'safety.getAllTags',
  'safety.updateTag',
  'safety.deleteTag',
  'safety.linkTag',
  'safety.unlinkTag',
  'safety.getTagsForElement',
  'safety.getElementsForTag',
  'safety.linkTagCrossNs',
  'safety.unlinkTagCrossNs',
  'safety.getTagsForImportedElement',
  'safety.getSafetyData',
];
const supported = new Set(atomicSafetyChannels);

export function resolveSafetyRefs(value: unknown, captured: Map<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map(item => resolveSafetyRefs(item, captured));
  if (!value || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  if (Object.hasOwn(object, '$ref')) {
    if (typeof object.$ref !== 'string' || !captured.has(object.$ref)) throw new Error(`Unknown or forward $ref: ${String(object.$ref)}`);
    if (object.path !== undefined && typeof object.path !== 'string') throw new Error('Reference path must be a string');
    let result = captured.get(object.$ref);
    for (const part of object.path ? (object.path as string).split('.') : []) {
      if (!result || typeof result !== 'object' || !Object.hasOwn(result, part)) throw new Error(`Missing reference path ${object.$ref}.${String(object.path)}`);
      result = (result as Record<string, unknown>)[part];
    }
    if (result === undefined || result === null) throw new Error(`Reference ${object.$ref} has no usable value`);
    return result;
  }
  return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, resolveSafetyRefs(item, captured)]));
}
function validateNodeIds(payload: Record<string, unknown>, allowRefs: boolean): void {
  for (const [field, value] of Object.entries(payload)) {
    if (value === undefined) continue;
    if (field === 'nodeId' || field.endsWith('NodeId')) {
      if (allowRefs && value && typeof value === 'object' && Object.hasOwn(value, '$ref')) continue;
      if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${field} must be a nonnegative integer resolved in this workspace`);
    }
  }
}
export function validateSafetyOperations(operations: SafetyOperation[]): void {
  if (!Array.isArray(operations)) throw new Error('Batch must be an array of operations');
  const ids = new Set<string>();
  function refs(value: unknown) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(refs); return; }
    const item = value as Record<string, unknown>;
    if (Object.hasOwn(item, '$ref')) {
      if (typeof item.$ref !== 'string' || !ids.has(item.$ref)) throw new Error(`Unknown or forward $ref: ${String(item.$ref)}`);
      if (item.path !== undefined && (typeof item.path !== 'string' || !item.path)) throw new Error('Reference path must be a nonempty string');
    } else Object.values(item).forEach(refs);
  }
  for (const op of operations) {
    if (!op || !supported.has(op.channel)) throw new Error(`Unsupported atomic safety channel: ${op?.channel}`);
    if (op.payload !== undefined && (!op.payload || typeof op.payload !== 'object' || Array.isArray(op.payload))) throw new Error('Operation payload must be an object');
    if (op.id !== undefined && (typeof op.id !== 'string' || !op.id.trim() || ids.has(op.id))) throw new Error(`Invalid or duplicate operation id: ${String(op.id)}`);
    validateNodeIds(op.payload ?? {}, true);
    refs(op.payload);
    if (op.id) ids.add(op.id);
  }
}

/** Caller owns readiness and final close. No auto-save is scheduled in this scope.
 * Errors discard tentative results: none of their created identities are durable. */
export async function runSafetyRequest(
  deps: ServiceDependencies, workingDir: string, operations: SafetyOperation[], options: { requestId?: string } = {},
): Promise<SafetyRequestResult> {
  try {
    validateSafetyOperations(operations);
    if (options.requestId !== undefined) {
      const receipt = readSafetyRequestReceipt(workingDir, options.requestId);
      if (receipt) {
        if (receipt.digest !== requestDigest(operations)) throw new Error('Request ID was already used with different operations');
        return receipt.result;
      }
    }
  }
  catch (err) { return { schemaVersion: 1, ok: false, changesCommitted: false, error: { code: 'INVALID_REQUEST', message: String(err instanceof Error ? err.message : err) } }; }
  const dispatcher = createCommandDispatcher();
  const mutates = operations.some(op => !!dispatcher.getChannelMeta(op.channel)?.mutates);
  const results: SafetyOperationResult[] = [];
  const captured = new Map<string, unknown>();
  let storeLogger: ReturnType<ServiceDependencies['loggers']['workspace']> | undefined;
  let index = 0;
  let phase = 'execute';
  let committed = false;
  let published = false;
  let tx: Awaited<ReturnType<NonNullable<IDbModule['beginTransaction']>>> | undefined;
  let publication: ReturnType<typeof beginAtomicPublication> | undefined;
  try {
    await deps.workspaceService.whenLoadSettled();
    const status = await deps.workspaceService.getStatus();
    if (status.state !== 'open' || status.info.lifecycleAction === 'load_failed' || status.info.lifecycleAction === 'loading_from_ria_data') throw new Error('Workspace initialization has not completed successfully');
    if (mutates) {
      if (deps.autoSave) throw new Error('Atomic safety requests require a session with auto-save disabled');
      if (!deps.dbModule.beginTransaction) throw new Error('Database transaction support is required');
      assertNoSnapshotDrift(workingDir, undefined);
      publication = beginAtomicPublication(workingDir);
      tx = await deps.dbModule.beginTransaction();
    }
    const db: IDbModule = tx ? { ...deps.dbModule, runQuery: (query, params) => tx!.runQuery(query, params), beginTransaction: undefined } : deps.dbModule;
    const instances = createInstanceService(db);
    const scoped: ServiceDependencies = { ...deps, dbModule: db, autoSave: undefined, instanceService: instances,
      safetyCommands: createSafetyCommands(instances, db, { transactionBound: !!tx }) };
    for (; index < operations.length; index++) {
      const op = operations[index];
      const payload = resolveSafetyRefs(op.payload ?? {}, captured) as Record<string, unknown>;
      validateNodeIds(payload, false);
      let result: unknown = await dispatcher.dispatch(op.channel as never, payload as never, scoped);
      // Create outputs retain node_id for in-session references, and expose the
      // durable UUID for subsequent processes. A create without identity fails.
      if (op.channel.startsWith('safety.create') && result && typeof result === 'object' && 'node_id' in result) {
        const created = await instances.getInstance(Number((result as { node_id: number }).node_id));
        if (!created.ok) throw new Error(created.error);
        const uuid = created.data.attributes.uuid;
        if (typeof uuid !== 'string' || !uuid) throw new Error('Created object has no UUID');
        result = { ...result, uuid };
      }
      if (op.id) captured.set(op.id, result);
      results.push({ index, id: op.id, channel: op.channel, result });
    }
    if (publication && tx) {
      phase = 'save';
      const logger = storeLogger = deps.loggers.workspace(workingDir);
      const stored = await createPersistorService(db, logger).store({ workingDir: publication.stagingDir });
      if (stored.skipped_types?.length) throw new Error('Snapshot export omitted records: ' + JSON.stringify(stored.skipped_types));
      phase = 'verify';
      await verifySafetySnapshot(publication.stagingDir, db);
      phase = 'publish';
      published = true; // Even the first rename may fail; journal recovery owns it.
      publication.publish();
      await tx.commit(); tx = undefined;
      publication.commit(options.requestId === undefined ? undefined : {
        version: 1, key: requestKey(options.requestId), digest: requestDigest(operations),
        result: { schemaVersion: 1, ok: true, changesCommitted: true, results },
      }); committed = true;
      stampBaseline(workingDir, undefined, { reason: 'store' });
      deps.workspaceService.notifyStoreCompleted();
      publication.finish();
    }
    return { schemaVersion: 1, ok: true, changesCommitted: mutates, results };
  } catch (err) {
    let message = err instanceof Error ? err.message : String(err);
    let changesCommitted: boolean | undefined = committed ? true : false;
    try {
      if (tx) { await tx.rollback(); tx = undefined; }
      if (publication) {
        if (published) {
          await deps.workspaceService.close();
          const recovered = recoverAtomicPublication(workingDir, publication.token);
          if (recovered !== undefined) changesCommitted = recovered === 'committed';
        } else publication.abort();
      }
    } catch (recoveryError) {
      changesCommitted = committed ? true : undefined;
      message += `; recovery required: ${String(recoveryError instanceof Error ? recoveryError.message : recoveryError)}`;
    }
    return { schemaVersion: 1, ok: false, changesCommitted, error: {
      code: changesCommitted === undefined ? 'OUTCOME_UNKNOWN' : `${phase.toUpperCase()}_FAILED`, message,
      ...(phase === 'execute' ? { index, operationId: operations[index]?.id } : {}),
    } };
  } finally {
    storeLogger?.close();
    if (publication) clearBaseline(publication.stagingDir);
  }
}
