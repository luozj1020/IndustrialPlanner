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

import {
  CERTIFIED_AREA_RELAXATION_PROFILE,
  CERTIFIED_AREA_RELAXATION_OBJECTIVE,
  solveCpSatAreaLowerBound,
} from "@/headless/certified-area-relaxation";

const OPTIONS = {
  devices: [{ id: "machine", width: 2, height: 3 }],
  limitWidth: 8,
  limitHeight: 8,
  allowRotate: true,
  maxSeconds: 1,
  scriptPath: "/tmp/certified-area-relaxation.py",
} as const;

describe("certified area relaxation bridge", () => {
  afterEach(() => {
    spawnSyncMock.mockReset();
    delete process.env["INDUSTRIAL_PLANNER_PYTHON"];
  });

  it("keeps the proof DTO isolated from search-only fields", () => {
    process.env["INDUSTRIAL_PLANNER_PYTHON"] = "certified-python";
    spawnSyncMock.mockReturnValueOnce(processResult({
      status: "optimal",
      rawBestObjectiveBound: 6,
      certifiedIntegerLowerBound: 6,
      masterIncumbentArea: 6,
    }));

    solveCpSatAreaLowerBound({
      ...OPTIONS,
      devices: [{
        id: "machine",
        width: 2,
        height: 3,
        fixedPlacement: { x: 5, y: 5, rotation: 0 },
        portRequirements: [{ escapeDepth: 3 }],
      }],
      clusters: [{ terminalId: "machine" }],
      forbiddenLayouts: [[{ id: "machine", x: 0, y: 0 }]],
      objectiveWeights: { boundingArea: 1_000_000 },
    } as unknown as Parameters<typeof solveCpSatAreaLowerBound>[0]);

    const input = JSON.parse(String(spawnSyncMock.mock.calls[0]?.[2]?.input)) as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual([
      "allowRotate",
      "constraintProfile",
      "devices",
      "limitHeight",
      "limitWidth",
      "maxSeconds",
      "objective",
    ]);
    expect(input["devices"]).toEqual([{ id: "machine", width: 2, height: 3 }]);
  });

  it("keeps the solver bound distinct from the placement-only incumbent", () => {
    process.env["INDUSTRIAL_PLANNER_PYTHON"] = "certified-python";
    spawnSyncMock.mockReturnValueOnce(processResult({
      status: "feasible",
      rawBestObjectiveBound: 12,
      certifiedIntegerLowerBound: 12,
      masterIncumbentArea: 15,
      elapsedMs: 1_001,
    }));

    expect(solveCpSatAreaLowerBound(OPTIONS)).toEqual({
      constraintProfile: CERTIFIED_AREA_RELAXATION_PROFILE,
      objective: CERTIFIED_AREA_RELAXATION_OBJECTIVE,
      status: "feasible",
      rawBestObjectiveBound: 12,
      certifiedIntegerLowerBound: 12,
      masterIncumbentArea: 15,
      pythonVersion: "3.13.9",
      orToolsVersion: "9.15.6755",
      elapsedMs: 1_001,
    });
  });

  it("reports relaxation infeasibility as a proof result", () => {
    process.env["INDUSTRIAL_PLANNER_PYTHON"] = "certified-python";
    spawnSyncMock.mockReturnValueOnce(processResult({ status: "infeasible" }));

    expect(solveCpSatAreaLowerBound(OPTIONS)).toMatchObject({
      constraintProfile: CERTIFIED_AREA_RELAXATION_PROFILE,
      objective: CERTIFIED_AREA_RELAXATION_OBJECTIVE,
      status: "infeasible",
    });
  });

  it("rejects an envelope whose float and exact integer bounds disagree", () => {
    process.env["INDUSTRIAL_PLANNER_PYTHON"] = "certified-python";
    spawnSyncMock.mockReturnValue(processResult({
      status: "feasible",
      rawBestObjectiveBound: 12.5,
      certifiedIntegerLowerBound: 12,
      masterIncumbentArea: 15,
    }));

    expect(solveCpSatAreaLowerBound(OPTIONS)).toEqual({
      constraintProfile: CERTIFIED_AREA_RELAXATION_PROFILE,
      objective: CERTIFIED_AREA_RELAXATION_OBJECTIVE,
      status: "solver-failed",
    });
  });

  it("rejects a malformed placement-only witness at the proof boundary", () => {
    process.env["INDUSTRIAL_PLANNER_PYTHON"] = "certified-python";
    spawnSyncMock.mockReturnValue(processResult({
      status: "optimal",
      rawBestObjectiveBound: 6,
      certifiedIntegerLowerBound: 6,
      masterIncumbentArea: 6,
      masterPlacement: [{
        id: "machine",
        x: 0,
        y: 0,
        width: 1,
        height: 6,
        rotation: 0,
      }],
    }));

    expect(solveCpSatAreaLowerBound(OPTIONS)).toEqual({
      constraintProfile: CERTIFIED_AREA_RELAXATION_PROFILE,
      objective: CERTIFIED_AREA_RELAXATION_OBJECTIVE,
      status: "solver-failed",
    });
  });

  it("validates the proof model domain before invoking Python", () => {
    expect(() => solveCpSatAreaLowerBound({
      ...OPTIONS,
      devices: [
        { id: "duplicate", width: 1, height: 1 },
        { id: "duplicate", width: 1, height: 1 },
      ],
    })).toThrow(/Duplicate certified relaxation device ID/);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
});

function processResult(envelope: Record<string, unknown>) {
  return {
    status: 0,
    signal: null,
    stdout: JSON.stringify({
      constraintProfile: CERTIFIED_AREA_RELAXATION_PROFILE,
      objective: CERTIFIED_AREA_RELAXATION_OBJECTIVE,
      pythonVersion: "3.13.9",
      orToolsVersion: "9.15.6755",
      ...envelope,
    }),
    stderr: "",
  };
}
