import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorldDocumentDelta } from "@/editor/history/history-delta";
import { EditorHistoryRuntime } from "@/editor/history/history-runtime";
import { createEditorStateReadWrite } from "@/editor/state-impl";
import { readEditorHistoryState, writeEditorHistoryState } from "@/editor/history/history-storage";
import { createDummyWorldDocument } from "@/tests/helpers/dummy-document";
import type { EditorHistoryDocumentDelta } from "@/domain/editor/editor-history";

vi.mock("@/editor/history/history-storage", () => ({
  readEditorHistoryState: vi.fn(async () => null),
  writeEditorHistoryState: vi.fn(async () => undefined),
}));

afterEach(() => vi.clearAllMocks());

describe("history equality and persistence", () => {
  it("ignores object key order while retaining array order", () => {
    const before = createDummyWorldDocument();
    const entity = before.entities["dummy-entity-2"]!;
    const first = { ...before, entities: { ...before.entities, [entity.id]: {
      ...entity, config: { nested: { a: 1, b: 2 }, values: [1, 2] },
    } } };
    const reordered = { ...before, entities: { ...before.entities, [entity.id]: {
      ...entity, config: { values: [1, 2], nested: { b: 2, a: 1 } },
    } } };
    expect(createWorldDocumentDelta(first, reordered)).toBeNull();
    const changed = { ...before, entities: { ...before.entities, [entity.id]: {
      ...entity, config: { values: [2, 1], nested: { b: 2, a: 1 } },
    } } };
    expect(createWorldDocumentDelta(first, changed)?.entities.updated[entity.id]).toBeDefined();
  });

  it("coalesces queued snapshots separately for each document", async () => {
    const state = createEditorStateReadWrite().history;
    const runtime = new EditorHistoryRuntime(state);
    const delta: EditorHistoryDocumentDelta = {
      entities: { added: {}, removed: {}, updated: {} },
      entityOrder: null, slotLinks: null, documentSettings: {},
    };
    runtime.clear("a");
    for (let i = 0; i < 2; i++) runtime.record({ documentKey: "a", delta, action: { type: "document.unknown", label: "edit" } });
    runtime.clear("b");
    runtime.record({ documentKey: "b", delta, action: { type: "document.unknown", label: "edit" } });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(writeEditorHistoryState).toHaveBeenCalledTimes(2);
    expect(writeEditorHistoryState).toHaveBeenNthCalledWith(1, expect.objectContaining({ documentKey: "a", cursorSequence: 2 }));
    expect(writeEditorHistoryState).toHaveBeenNthCalledWith(2, expect.objectContaining({ documentKey: "b", cursorSequence: 1 }));
  });

  it("waits for pending writes before reloading a document", async () => {
    let finish!: () => void;
    vi.mocked(writeEditorHistoryState).mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
    const state = createEditorStateReadWrite().history;
    const runtime = new EditorHistoryRuntime(state);
    runtime.clear("a");
    runtime.loadDocumentHistory("a");
    await Promise.resolve();
    expect(readEditorHistoryState).not.toHaveBeenCalled();
    finish();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(readEditorHistoryState).toHaveBeenCalledWith("a");
    expect(state.isReady).toBe(true);
  });
});
