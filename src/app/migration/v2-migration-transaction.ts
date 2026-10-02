import type { BlueprintDocument } from "@/domain/document/blueprint-document";
import type { WorldDocument } from "@/domain/document/world-document";
import type { WorkbenchStateReadWrite } from "@/app/state/state-impl";
import type { EditorPersistState } from "@/shared/storage/editor-persist-state-storage";
import { applyIndexedDbTransactionMutations, readFromIndexedDb, deleteFromIndexedDb } from "@/shared/storage/browser-storage";
import { BLUEPRINT_STORE_LOCATION, type BlueprintRecord, type BlueprintFolderRecord } from "@/shared/storage/blueprint-storage";
import { WORLD_DOCUMENT_DATABASE_LOCATION } from "@/shared/storage/world-document-storage";
import type { V2MigrationCompletionSummary } from "./v2-migration-state";
import { V3_MIGRATED_BLUEPRINT_FOLDER_ID } from "./v2-migration-keys";

const RECEIPT_LOCATION = {
  databaseName: WORLD_DOCUMENT_DATABASE_LOCATION.databaseName,
  storeName: "migration-recovery",
  key: "v2-to-v3",
};

/** A committed receipt allows localStorage finalization to resume after interruption. */
export interface V2MigrationReceipt {
  readonly schemaVersion: 1;
  readonly completedAt: string;
  readonly summary: V2MigrationCompletionSummary;
  readonly editorState: EditorPersistState;
  readonly moduleBalancing: WorkbenchStateReadWrite["toolbox"]["moduleBalancing"];
}

export async function readPendingV2Migration(): Promise<V2MigrationReceipt | null> {
  return readFromIndexedDb<V2MigrationReceipt>(RECEIPT_LOCATION);
}

export async function clearPendingV2Migration(): Promise<void> {
  if (!await deleteFromIndexedDb(RECEIPT_LOCATION)) {
    throw new Error("Failed to clear the v2 migration recovery receipt.");
  }
}

export async function commitV2MigrationDocuments(
  documents: readonly WorldDocument[],
  blueprints: readonly BlueprintDocument[],
  receipt: V2MigrationReceipt,
): Promise<void> {
  const folder: BlueprintFolderRecord = {
    schemaVersion: 1,
    kind: "folder",
    folderId: V3_MIGRATED_BLUEPRINT_FOLDER_ID,
    name: "迁移的蓝图",
    parentFolderId: null,
    createdAt: receipt.completedAt,
    updatedAt: receipt.completedAt,
    deletedAt: null,
  };
  const records: BlueprintRecord[] = blueprints.map((blueprint) => ({
    ...blueprint,
    kind: "blueprint",
    parentFolderId: folder.folderId,
    deletedAt: null,
  }));
  const didCommit = await applyIndexedDbTransactionMutations<unknown>(
    { databaseName: RECEIPT_LOCATION.databaseName },
    [
      { storeName: WORLD_DOCUMENT_DATABASE_LOCATION.storeName, operations: [
        { type: "clear" },
        ...documents.map((document) => ({ type: "put" as const, key: document.documentKey, value: document })),
      ] },
      { storeName: BLUEPRINT_STORE_LOCATION.storeName, operations: [
        { type: "put", key: `folder:${folder.folderId}`, value: folder },
        ...records.map((record) => ({ type: "put" as const, key: `blueprint:${record.blueprintId}`, value: record })),
      ] },
      { storeName: RECEIPT_LOCATION.storeName, operations: [
        { type: "put", key: RECEIPT_LOCATION.key, value: receipt },
      ] },
    ],
  );
  if (!didCommit) throw new Error("Failed to commit v2 migration documents. No migration was completed.");
}
