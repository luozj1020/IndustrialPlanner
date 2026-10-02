// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppHost } from "@/app/host/app-host";
import { executeV2Migration } from "@/app/migration/v2-migration-executor";
import { readPendingV2Migration } from "@/app/migration/v2-migration-transaction";
import { V2_USER_BLUEPRINTS_LOCAL_STORAGE_KEY, V3_MIGRATION_STATE_LOCAL_STORAGE_KEY } from "@/app/migration/v2-migration-keys";
import { WORKBENCH_STATE_LOCAL_STORAGE_KEY } from "@/app/state/storage-hook";
import { createFakeIndexedDbFactory } from "@/tests/shared/fake-indexed-db";
import { createWorldDocument } from "@/domain/document/world-document";
import { listWorldDocuments, writeWorldDocument } from "@/shared/storage/world-document-storage";
import * as browserStorage from "@/shared/storage/browser-storage";
import { BLUEPRINT_STORE_LOCATION } from "@/shared/storage/blueprint-storage";

function host(): AppHost {
  return {
    workspace: { registry: { baseDefinitions: [] }, editor: null },
    internalState: { workbench: { toolbox: { moduleBalancing: { canvases: [], customModules: [], activeCanvasId: null } } } },
  } as unknown as AppHost;
}

describe("v2 migration commit and recovery", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("indexedDB", createFakeIndexedDbFactory());
    localStorage.setItem(V2_USER_BLUEPRINTS_LOCAL_STORAGE_KEY, JSON.stringify([{
      id: "legacy-1", name: "Legacy blueprint", version: "1.2.0.4", blueprintVersion: "1", baseId: "wuling_protocol_core", source: "user",
      createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z",
      devices: [{ blueprintInstanceId: "device-1", typeId: "item_port_storager_1", rotation: 0, origin: { x: 0, y: 0 }, config: {} }], links: [],
    }]));
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("leaves the original maps and completion marker untouched on transaction failure", async () => {
    const original = createWorldDocument();
    await writeWorldDocument(original);
    vi.spyOn(browserStorage, "applyIndexedDbTransactionMutations").mockResolvedValueOnce(false);
    await expect(executeV2Migration(host())).rejects.toThrow("Failed to commit");
    expect(await listWorldDocuments()).toEqual([original]);
    expect(localStorage.getItem(V3_MIGRATION_STATE_LOCAL_STORAGE_KEY)).toBeNull();
    expect(await readPendingV2Migration()).toBeNull();
  });

  it("keeps a durable receipt on localStorage failure and resumes without importing twice", async () => {
    const appHost = host();
    const originalSetItem = Storage.prototype.setItem;
    const failWrite = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key === WORKBENCH_STATE_LOCAL_STORAGE_KEY) throw new Error("quota");
      originalSetItem.call(this, key, value);
    });
    await expect(executeV2Migration(appHost)).rejects.toThrow("quota");
    expect((await readPendingV2Migration())?.summary.migratedBlueprintCount).toBe(1);
    expect(localStorage.getItem(V3_MIGRATION_STATE_LOCAL_STORAGE_KEY)).toBeNull();
    failWrite.mockRestore();
    const result = await executeV2Migration(appHost);
    expect(result.migratedBlueprintCount).toBe(1);
    expect(await readPendingV2Migration()).toBeNull();
    const entries = await browserStorage.listFromIndexedDb<{ kind: string }>(BLUEPRINT_STORE_LOCATION);
    expect(entries.filter((entry) => entry.kind === "blueprint")).toHaveLength(1);
    expect(localStorage.getItem(V2_USER_BLUEPRINTS_LOCAL_STORAGE_KEY)).not.toBeNull();
    expect(JSON.parse(localStorage.getItem(V3_MIGRATION_STATE_LOCAL_STORAGE_KEY)!)).toMatchObject({ summary: { migratedBlueprintCount: 1 } });
  });

  it("serializes all values before a transaction can delete existing data", async () => {
    const location = { databaseName: "review", storeName: "state" };
    await browserStorage.saveToIndexedDb({ ...location, key: "original" }, { value: 1 });
    const circular: { self?: unknown } = {}; circular.self = circular;
    expect(await browserStorage.applyIndexedDbStoreMutations(location, [
      { type: "delete", key: "original" }, { type: "put", key: "bad", value: circular },
    ])).toBe(false);
    expect(await browserStorage.readFromIndexedDb({ ...location, key: "original" })).toEqual({ value: 1 });
  });

  it("rolls back all stores when one write request fails", async () => {
    const location = { databaseName: "rollback", storeName: "maps", key: "old" };
    await browserStorage.saveToIndexedDb(location, { old: true });
    expect(await browserStorage.applyIndexedDbTransactionMutations<unknown>({ databaseName: location.databaseName }, [
      { storeName: "maps", operations: [{ type: "clear" }, { type: "put", key: "new", value: {} }] },
      { storeName: "blueprints", operations: [{ type: "put", key: undefined as unknown as IDBValidKey, value: {} }] },
    ])).toBe(false);
    expect(await browserStorage.readFromIndexedDb(location)).toEqual({ old: true });
    expect(await browserStorage.readFromIndexedDb({ ...location, key: "new" })).toBeNull();
  });
});
