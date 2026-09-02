import { afterEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    default: { ...actual, spawnSync: spawnSyncMock },
    spawnSync: spawnSyncMock,
  };
});

import { normalizeCpSatStatus, solveCpSatLayouts } from "../../headless/cp-sat-layout";

const OPTIONS = {
  devices: [{ id: "machine", width: 2, height: 3 }],
  edges: [],
  clusters: [],
  limitWidth: 8,
  limitHeight: 8,
  routingClearance: 0,
  allowRotate: true,
  maxSeconds: 1,
  candidateCount: 1,
  seed: 1,
  scriptPath: "/tmp/cp-sat-layout.py",
} as const;

describe("CP-SAT bridge observability", () => {
  afterEach(() => {
    spawnSyncMock.mockReset();
    delete process.env["INDUSTRIAL_PLANNER_PYTHON"];
  });

  it("classifies every public status through the production normalizer", () => {
    expect(normalizeCpSatStatus("disabled", 0)).toBe("disabled");
    expect(normalizeCpSatStatus("executable-missing", null)).toBe("executable-missing");
    expect(normalizeCpSatStatus("dependency-missing", 0)).toBe("dependency-missing");
    expect(normalizeCpSatStatus("timeout", 0)).toBe("timeout");
    expect(normalizeCpSatStatus("solver-failed", 0)).toBe("solver-failed");
    expect(normalizeCpSatStatus("no-layouts", 0)).toBe("no-layouts");
    expect(normalizeCpSatStatus("success", 0)).toBe("success");
    expect(normalizeCpSatStatus(undefined, 2)).toBe("dependency-missing");
    expect(normalizeCpSatStatus(undefined, 1)).toBe("solver-failed");
  });

  it("continues across failed interpreters until a usable result is found", () => {
    process.env["INDUSTRIAL_PLANNER_PYTHON"] = "custom-python";
    spawnSyncMock
      .mockReturnValueOnce(processResult({
        status: "dependency-missing",
        pythonVersion: "3.11.0",
      }))
      .mockReturnValueOnce({
        status: null,
        signal: null,
        stdout: "",
        stderr: "",
        error: Object.assign(new Error("missing"), { code: "ENOENT" }),
      })
      .mockReturnValueOnce(processResult({
        status: "success",
        pythonVersion: "3.12.1",
        orToolsVersion: "9.15.6755",
        attemptedCandidates: 1,
        stoppedBy: "completed",
        elapsedMs: 125,
        layouts: [[{ id: "machine", x: 1, y: 2, rotation: 90, width: 3, height: 2 }]],
      }));

    expect(solveCpSatLayouts(OPTIONS)).toEqual({
      status: "success",
      pythonVersion: "3.12.1",
      orToolsVersion: "9.15.6755",
      attemptedCandidates: 1,
      stoppedBy: "completed",
      elapsedMs: 125,
      layouts: [[{ id: "machine", x: 1, y: 2, rotation: 90, width: 3, height: 2 }]],
    });
    expect(spawnSyncMock).toHaveBeenCalledTimes(3);
  });

  it("shares one solver budget across candidates and does not retry a valid budget timeout", () => {
    process.env["INDUSTRIAL_PLANNER_PYTHON"] = "custom-python";
    spawnSyncMock.mockReturnValueOnce(processResult({
      status: "timeout",
      pythonVersion: "3.13.9",
      orToolsVersion: "9.15.6755",
      attemptedCandidates: 3,
      stoppedBy: "total-budget",
      elapsedMs: 2_006,
    }));

    expect(solveCpSatLayouts({
      ...OPTIONS,
      maxSeconds: 2,
      candidateCount: 12,
    })).toEqual({
      layouts: [],
      status: "timeout",
      pythonVersion: "3.13.9",
      orToolsVersion: "9.15.6755",
      attemptedCandidates: 3,
      stoppedBy: "total-budget",
      elapsedMs: 2_006,
    });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(spawnSyncMock.mock.calls[0]?.[2]).toMatchObject({ timeout: 17_000 });
  });

  it("serializes route-aware port escape rays into the mathematical model", () => {
    process.env["INDUSTRIAL_PLANNER_PYTHON"] = "custom-python";
    spawnSyncMock.mockReturnValueOnce(processResult({ status: "no-layouts" }));

    solveCpSatLayouts({
      ...OPTIONS,
      devices: [{
        id: "machine",
        width: 2,
        height: 3,
        portRequirements: [{
          direction: "output",
          requiredCount: 1,
          escapeDepth: 2,
          ports: [{
            id: "belt:item-output:out-1",
            offsets: { 0: { x: 2, y: 1 } },
            escapeEdges: { 0: "EAST" },
          }],
        }],
      }],
    });

    const input = JSON.parse(String(spawnSyncMock.mock.calls[0]?.[2]?.input)) as {
      devices: Array<{ portRequirements?: unknown }>;
    };
    expect(input.devices[0]?.portRequirements).toEqual([{
      direction: "output",
      requiredCount: 1,
      escapeDepth: 2,
      ports: [{
        id: "belt:item-output:out-1",
        offsets: { 0: { x: 2, y: 1 } },
        escapeEdges: { 0: "EAST" },
      }],
    }]);
  });

  it("serializes conditional explicit grid edge cuts into the mathematical model", () => {
    process.env["INDUSTRIAL_PLANNER_PYTHON"] = "custom-python";
    spawnSyncMock.mockReturnValueOnce(processResult({ status: "no-layouts" }));
    const capacityCut = {
      axis: "vertical" as const,
      coordinate: 4,
      gridWidth: 8,
      gridHeight: 8,
      requiredCapacity: 3,
      cutEdges: Array.from({ length: 8 }, (_, y) => ({
        from: { x: 3, y },
        to: { x: 4, y },
      })),
      fixedBlockedEdgeIndexes: [0, 7],
      activeWhenPlacements: [
        { id: "machine", x: 1, y: 2, rotation: 0 as const, width: 2, height: 3 },
      ],
    };

    solveCpSatLayouts({ ...OPTIONS, capacityCuts: [capacityCut] });

    const input = JSON.parse(String(spawnSyncMock.mock.calls[0]?.[2]?.input)) as {
      capacityCuts?: unknown;
    };
    expect(input.capacityCuts).toEqual([capacityCut]);
  });

  it("returns the most informative bounded failure after exhausting interpreters", () => {
    process.env["INDUSTRIAL_PLANNER_PYTHON"] = "custom-python";
    spawnSyncMock
      .mockReturnValueOnce({ status: null, signal: "SIGTERM", stdout: "", stderr: "" })
      .mockReturnValueOnce(processResult({ status: "dependency-missing" }))
      .mockReturnValueOnce(processResult({ status: "solver-failed" }));

    expect(solveCpSatLayouts(OPTIONS)).toEqual({ layouts: [], status: "timeout" });
    expect(spawnSyncMock).toHaveBeenCalledTimes(3);
  });
});

function processResult(envelope: Record<string, unknown>) {
  return {
    status: 0,
    signal: null,
    stdout: JSON.stringify({ layouts: [], ...envelope }),
    stderr: "",
  };
}
