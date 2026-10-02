// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { runInAction } from "mobx";
import { createAppHost, type AppHost } from "@/app/host/app-host";
import { ModuleBalancingPanel } from "@/app/shell/module-balancing/module-balancing-panel";
import { createWorkspaceState } from "@/domain/document/workspace-state";
import { createRegistryContract } from "@/registry";

describe("module stage drag mode", () => {
  let root: Root | undefined;
  let host: AppHost | undefined;
  let container: HTMLDivElement | undefined;
  afterEach(() => {
    act(() => root?.unmount());
    host?.dispose();
    container?.remove();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it.each([false, true])("uses the actual touch mode (%s) for stage entries", (isTouch) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const appHost = createAppHost({
      state: createWorkspaceState(), registry: createRegistryContract(),
      app: null, editor: null, render: null, simulation: null,
    });
    host = appHost;
    const balancing = appHost.internalState.workbench.toolbox.moduleBalancing;
    runInAction(() => {
      balancing.customModules = ["first", "second"].map((id) => ({
        id, name: id, notes: "", color: "#ffffff", iconId: "", sourceType: "custom" as const,
        inputs: [], outputs: [],
      }));
      balancing.canvases[0]!.stages[0]!.entries = [
        { moduleId: "first", quantity: 1 }, { moduleId: "second", quantity: 1 },
      ];
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(<ModuleBalancingPanel appHost={appHost} isTouch={isTouch} />));
    const stageTab = Array.from(container.querySelectorAll<HTMLButtonElement>("nav button"))
      .find((button) => button.textContent === "Stage 1");
    expect(stageTab).toBeDefined();
    act(() => stageTab!.click());
    const entries = container.querySelectorAll<HTMLButtonElement>(".module-balancing-stage-entry");
    expect(entries).toHaveLength(2);
    expect(entries[0]!.draggable).toBe(!isTouch);
    expect(entries[1]!.draggable).toBe(!isTouch);
    if (isTouch) return;

    const values = new Map<string, string>();
    const dataTransfer = {
      setData: (key: string, value: string) => { values.set(key, value); },
      getData: (key: string) => values.get(key) ?? "",
      get types() { return [...values.keys()]; },
      effectAllowed: "none",
    };
    const drag = (element: Element, type: string) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
      element.dispatchEvent(event);
    };
    act(() => {
      drag(entries[0]!, "dragstart");
      drag(entries[1]!, "dragover");
      drag(entries[1]!, "drop");
    });
    expect(balancing.canvases[0]!.stages[0]!.entries.map((entry) => entry.moduleId))
      .toEqual(["second", "first"]);
  });
});
