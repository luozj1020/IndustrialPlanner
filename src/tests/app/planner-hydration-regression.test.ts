// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInAction } from "mobx";
import { ProductionPlanningInputStore } from "@/app/shell/production-planning/production-planning-state";
import { hookPlannerIndexedDbPersistence } from "@/app/shell/production-planning/production-planning-persist";
import { loadPlannerState, savePlannerState, type PlannerPersistedState } from "@/shared/storage/planner-storage";

vi.mock("@/shared/storage/planner-storage", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/shared/storage/planner-storage")>(),
  loadPlannerState: vi.fn(), savePlannerState: vi.fn(async () => undefined),
}));

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe("planner hydration and coalesced persistence", () => {
  let dispose: (() => void) | undefined;
  beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
  afterEach(async () => { dispose?.(); dispose = undefined; await flushMicrotasks(); vi.useRealTimers(); });

  it("preserves edits made while a saved document is loading", async () => {
    let resolve!: (value: PlannerPersistedState) => void;
    vi.mocked(loadPlannerState).mockReturnValue(new Promise((r) => { resolve = r; }));
    const store = new ProductionPlanningInputStore();
    dispose = hookPlannerIndexedDbPersistence(store);
    runInAction(() => { store.targets = [{ id: "new", itemId: "new-item", perMinute: 5 }]; });
    resolve({ targets: [], supplies: [], recipeChoices: {}, recipeChoicesDemandSignature: null, displayMode: "device", viewMode: "tree", sourceConfig: { ...store.sourceConfig }, session: { ...store.session } });
    await flushMicrotasks();
    expect(store.targets[0]?.itemId).toBe("new-item");
    expect(store.hydrated).toBe(true);
    await vi.advanceTimersByTimeAsync(150);
    expect(savePlannerState).toHaveBeenCalledWith(expect.objectContaining({ targets: [{ id: "new", itemId: "new-item", perMinute: 5 }] }));
  });

  it("does not hydrate a disposed store", async () => {
    let resolve!: (value: null) => void;
    vi.mocked(loadPlannerState).mockReturnValue(new Promise((r) => { resolve = r; }));
    const store = new ProductionPlanningInputStore();
    dispose = hookPlannerIndexedDbPersistence(store);
    dispose(); dispose = undefined;
    resolve(null); await flushMicrotasks();
    expect(store.hydrated).toBe(false);
    expect(savePlannerState).not.toHaveBeenCalled();
  });

  it("flushes edits on dispose even while hydration is still pending", async () => {
    let resolve!: (value: null) => void;
    vi.mocked(loadPlannerState).mockReturnValue(new Promise((r) => { resolve = r; }));
    const store = new ProductionPlanningInputStore();
    dispose = hookPlannerIndexedDbPersistence(store);
    runInAction(() => { store.targets = [{ id: "last", itemId: "item", perMinute: 7 }]; });
    dispose(); dispose = undefined;
    await flushMicrotasks();
    expect(savePlannerState).toHaveBeenCalledWith(expect.objectContaining({ targets: [{ id: "last", itemId: "item", perMinute: 7 }] }));
    resolve(null); await flushMicrotasks();
    expect(store.hydrated).toBe(false);
    expect(savePlannerState).toHaveBeenCalledTimes(1);
  });

  it("coalesces scroll updates and flushes the last value on dispose", async () => {
    vi.mocked(loadPlannerState).mockResolvedValue(null);
    const store = new ProductionPlanningInputStore();
    dispose = hookPlannerIndexedDbPersistence(store);
    await flushMicrotasks();
    for (let i = 1; i <= 20; i++) runInAction(() => { store.session.treeScrollTop = i; });
    expect(savePlannerState).not.toHaveBeenCalled();
    dispose(); dispose = undefined;
    await flushMicrotasks();
    expect(savePlannerState).toHaveBeenCalledTimes(1);
    expect(savePlannerState).toHaveBeenLastCalledWith(expect.objectContaining({ session: expect.objectContaining({ treeScrollTop: 20 }) }));
  });

  it("waits for the previous panel's final save before restoring a reopened panel", async () => {
    vi.mocked(loadPlannerState).mockResolvedValue(null);
    const first = new ProductionPlanningInputStore();
    dispose = hookPlannerIndexedDbPersistence(first);
    await flushMicrotasks();
    let finishWrite!: () => void;
    vi.mocked(savePlannerState).mockImplementationOnce(() => new Promise<void>((resolve) => { finishWrite = resolve; }));
    runInAction(() => { first.session.treeScrollTop = 42; });
    dispose();
    const reopened = new ProductionPlanningInputStore();
    dispose = hookPlannerIndexedDbPersistence(reopened);
    await flushMicrotasks();
    expect(loadPlannerState).toHaveBeenCalledTimes(1);
    expect(reopened.hydrated).toBe(false);
    finishWrite();
    await flushMicrotasks();
    expect(loadPlannerState).toHaveBeenCalledTimes(2);
    expect(reopened.hydrated).toBe(true);
  });
});
