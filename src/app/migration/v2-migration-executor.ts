import { runInAction } from "mobx";

import type { AppHost } from "@/app/host/app-host";
import type { BaseDefinition } from "@/domain/registry/types/base-definition";
import {
  convertLegacyBlueprintJson,
  convertLegacyV2LayoutToWorldDocument,
  createLegacyBlueprintJsonFromV2BlueprintSnapshot,
  filterLegacyV2LayoutBaseBuiltinEntities,
  normalizeLegacyV2BlueprintSnapshotsStorage,
  normalizeLegacyV2LayoutsByBaseStorage,
  readFromLocalStorage,
} from "@/shared/storage";

import {
  V2_ACTIVE_BASE_LOCAL_STORAGE_KEY,
  V2_LAYOUTS_BY_BASE_LOCAL_STORAGE_KEY,
  V2_LEGACY_USER_BLUEPRINTS_LOCAL_STORAGE_KEY,
  V2_USER_BLUEPRINTS_LOCAL_STORAGE_KEY,
  V3_MIGRATION_ID_PREFIX,
} from "./v2-migration-keys";
import { migrateV2ModuleBalancingState } from "./v2-module-balancing-migration";
import {
  type V2MigrationCompletionSummary,
  writeV2MigrationCompletedState,
  readV2MigrationState,
} from "./v2-migration-state";
import { WORKBENCH_STATE_LOCAL_STORAGE_KEY } from "@/app/state/storage-hook";
import { EDITOR_PERSIST_STATE_LOCAL_STORAGE_KEY } from "@/shared/storage/editor-persist-state-storage";
import { commitV2MigrationDocuments, readPendingV2Migration, clearPendingV2Migration, type V2MigrationReceipt } from "./v2-migration-transaction";
import { cleanupDiscardableV2LocalStorageBeforeV3Boot } from "./v2-storage-cleanup";

export interface V2MigrationExecutorResult extends V2MigrationCompletionSummary {
  readonly loadedBaseId: string | null;
}

export async function executeV2Migration(
  appHost: AppHost,
): Promise<V2MigrationExecutorResult> {
  cleanupDiscardableV2LocalStorageBeforeV3Boot();

  const pending = await readPendingV2Migration();
  if (pending !== null) return finalizeMigration(appHost, pending);

  // Prepare every conversion before touching the existing v3 documents.
  const migratedWorldDocuments = createMigratedWorldDocuments(appHost.workspace.registry.baseDefinitions);
  const blueprints = createMigratedUserBlueprints();
  const moduleResult = migrateV2ModuleBalancingState(appHost.internalState.workbench.toolbox.moduleBalancing);
  const receipt: V2MigrationReceipt = {
    schemaVersion: 1,
    completedAt: new Date().toISOString(),
    summary: {
      migratedMapCount: migratedWorldDocuments.length,
      migratedBlueprintCount: blueprints.length,
      migratedModuleCanvasCount: moduleResult.migratedCanvasCount,
      migratedCustomModuleCount: moduleResult.migratedCustomModuleCount,
    },
    editorState: {
      lastDocumentId: resolveLastMigratedDocumentId(migratedWorldDocuments),
      latestDocumentIdByBaseId: Object.fromEntries(
        migratedWorldDocuments.map((document) => [document.baseId, document.documentKey]),
      ),
    },
    moduleBalancing: moduleResult.state,
  };
  await commitV2MigrationDocuments(migratedWorldDocuments, blueprints, receipt);
  return finalizeMigration(appHost, receipt);
}

async function finalizeMigration(appHost: AppHost, receipt: V2MigrationReceipt): Promise<V2MigrationExecutorResult> {
  let loadedBaseId: string | null = null;
  if (readV2MigrationState().completedAt !== receipt.completedAt) {
    // These writes must throw on quota/storage failure. The durable IndexedDB
    // receipt is retained until all local settings have been finalized.
    const workbench = appHost.internalState.workbench;
    localStorage.setItem(WORKBENCH_STATE_LOCAL_STORAGE_KEY, JSON.stringify({
      ...workbench,
      toolbox: { ...workbench.toolbox, moduleBalancing: receipt.moduleBalancing },
    }));
    localStorage.setItem(EDITOR_PERSIST_STATE_LOCAL_STORAGE_KEY, JSON.stringify(receipt.editorState));
    runInAction(() => Object.assign(workbench.toolbox.moduleBalancing, receipt.moduleBalancing));
    loadedBaseId = await loadMigratedActiveBase(appHost, Object.entries(receipt.editorState.latestDocumentIdByBaseId)
      .map(([baseId, documentKey]) => ({ baseId, documentKey })));
    writeV2MigrationCompletedState(receipt.summary, receipt.completedAt);
  }
  await clearPendingV2Migration();
  return { ...receipt.summary, loadedBaseId };
}

function createMigratedWorldDocuments(baseDefinitions: readonly BaseDefinition[]) {
  const layoutsByBase = normalizeLegacyV2LayoutsByBaseStorage(
    readFromLocalStorage<unknown>(V2_LAYOUTS_BY_BASE_LOCAL_STORAGE_KEY),
  );

  return Object.values(layoutsByBase)
    .sort((left, right) => left.baseId.localeCompare(right.baseId))
    .flatMap((layout) => {
      const filteredLayout = filterLegacyV2LayoutBaseBuiltinEntities(
        layout,
        baseDefinitions,
      );
      const document = convertLegacyV2LayoutToWorldDocument(filteredLayout, {
        documentKey: createMigratedWorldDocumentKey(layout.baseId),
        blueprintId: `${V3_MIGRATION_ID_PREFIX}map-blueprint:${stableKeyPart(layout.baseId)}`,
        entityIdPrefix: `v2map_${stableKeyPart(layout.baseId)}`,
        name: `迁移地图 - ${layout.baseId}`,
      });

      if (document === null) throw new Error(`Failed to convert v2 map ${layout.baseId}.`);
      return [document];
    });
}

function createMigratedUserBlueprints() {
  const snapshots = readLegacyUserBlueprintSnapshots();
  const usedBlueprintIds = new Set<string>();
  const blueprints = [];

  for (const [snapshotIndex, snapshot] of snapshots.entries()) {
    const blueprintId = createMigratedBlueprintId(snapshot.id, snapshotIndex, usedBlueprintIds);
    const blueprint = convertLegacyBlueprintJson(
      createLegacyBlueprintJsonFromV2BlueprintSnapshot(snapshot),
      {
        blueprintId,
        entityIdPrefix: `v2bp_${stableKeyPart(blueprintId)}`,
      },
    );

    if (blueprint === null) throw new Error(`Failed to convert v2 blueprint ${snapshot.id}.`);

    blueprints.push(blueprint);
  }
  return blueprints;
}

function readLegacyUserBlueprintSnapshots() {
  const snapshots = normalizeLegacyV2BlueprintSnapshotsStorage(
    readFromLocalStorage<unknown>(V2_USER_BLUEPRINTS_LOCAL_STORAGE_KEY),
  );

  if (snapshots.length > 0) {
    return snapshots;
  }

  return normalizeLegacyV2BlueprintSnapshotsStorage(
    readFromLocalStorage<unknown>(V2_LEGACY_USER_BLUEPRINTS_LOCAL_STORAGE_KEY),
  );
}

async function loadMigratedActiveBase(
  appHost: AppHost,
  migratedWorldDocuments: readonly { baseId: string; documentKey: string }[],
): Promise<string | null> {
  const editor = appHost.workspace.editor;
  const activeBaseId = resolveMigratedActiveBaseId(migratedWorldDocuments);

  if (editor === null || activeBaseId === null) {
    return null;
  }

  const didLoad = await editor.actions.loadLatestBaseDocument(activeBaseId);

  if (!didLoad) throw new Error(`Failed to load migrated base ${activeBaseId}.`);
  return activeBaseId;
}

function resolveMigratedActiveBaseId(
  migratedWorldDocuments: readonly { baseId: string }[],
): string | null {
  const activeBaseId = normalizeOptionalString(
    readFromLocalStorage<unknown>(V2_ACTIVE_BASE_LOCAL_STORAGE_KEY),
  );

  if (
    activeBaseId !== null
    && migratedWorldDocuments.some((document) => document.baseId === activeBaseId)
  ) {
    return activeBaseId;
  }

  return migratedWorldDocuments[0]?.baseId ?? null;
}

function resolveLastMigratedDocumentId(
  migratedWorldDocuments: readonly { baseId: string; documentKey: string }[],
): string | null {
  const activeBaseId = resolveMigratedActiveBaseId(migratedWorldDocuments);

  if (activeBaseId !== null) {
    return migratedWorldDocuments.find((document) => document.baseId === activeBaseId)?.documentKey ?? null;
  }

  return migratedWorldDocuments[0]?.documentKey ?? null;
}

function createMigratedWorldDocumentKey(baseId: string): string {
  return `${V3_MIGRATION_ID_PREFIX}map:${stableKeyPart(baseId)}`;
}

function createMigratedBlueprintId(
  legacyBlueprintId: string,
  snapshotIndex: number,
  usedBlueprintIds: Set<string>,
): string {
  const baseId = `${V3_MIGRATION_ID_PREFIX}blueprint:${stableKeyPart(legacyBlueprintId)}`;

  if (!usedBlueprintIds.has(baseId)) {
    usedBlueprintIds.add(baseId);

    return baseId;
  }

  const indexedId = `${baseId}:${snapshotIndex}`;
  usedBlueprintIds.add(indexedId);

  return indexedId;
}

function stableKeyPart(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9_-]+/g, "_");

  return normalized === "" ? "unknown" : normalized;
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
