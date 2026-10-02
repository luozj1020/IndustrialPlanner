// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { observable, runInAction } from "mobx";
import { createPersistedReaction } from "@/shared/storage/persisted-reaction";

afterEach(() => vi.useRealTimers());

describe("persisted reaction", () => {
  it("coalesces nested reads and writes, flushes pagehide, and detaches on dispose", async () => {
    vi.useFakeTimers();
    const state = observable({ nested: { x: 0 } });
    const read = vi.fn(() => JSON.stringify(state));
    const write = vi.fn();
    const dispose = createPersistedReaction(read, write);
    const initialReads = read.mock.calls.length;
    for (let x = 1; x <= 20; x++) runInAction(() => { state.nested.x = x; });
    expect(read).toHaveBeenCalledTimes(initialReads);
    await vi.advanceTimersByTimeAsync(150);
    expect(write).toHaveBeenCalledTimes(1);
    runInAction(() => { state.nested.x = 30; });
    window.dispatchEvent(new Event("pagehide"));
    expect(write).toHaveBeenLastCalledWith('{"nested":{"x":30}}');
    dispose();
    runInAction(() => { state.nested.x = 40; });
    await vi.advanceTimersByTimeAsync(150);
    window.dispatchEvent(new Event("pagehide"));
    expect(write).toHaveBeenCalledTimes(2);
    dispose();
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("persists a value reverted after an explicit flush but before the delayed reaction", async () => {
    vi.useFakeTimers();
    const state = observable({ value: 0 });
    const write = vi.fn();
    const dispose = createPersistedReaction(() => state.value, write);
    try {
      runInAction(() => { state.value = 1; });
      window.dispatchEvent(new Event("pagehide"));
      expect(write).toHaveBeenLastCalledWith(1);
      runInAction(() => { state.value = 0; });
      await vi.advanceTimersByTimeAsync(150);
      expect(write).toHaveBeenLastCalledWith(0);
      expect(write).toHaveBeenCalledTimes(2);
    } finally {
      dispose();
    }
  });
});
