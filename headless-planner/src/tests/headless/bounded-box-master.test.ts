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
  BOUNDED_BOX_MASTER_PROFILE,
  solveBoundedBoxMaster,
} from "../../headless/bounded-box-master";

const OPTIONS = {
  devices: [
    { id: "a", width: 2, height: 3, hintPlacement: { x: 0, y: 0, rotation: 0 as const } },
    { id: "b", width: 2, height: 2 },
  ],
  mapWidth: 8,
  mapHeight: 8,
  boxWidth: 4,
  boxHeight: 4,
  allowRotate: true,
  maxSeconds: 1,
  candidateCount: 2,
  seed: 7,
  scriptPath: "/tmp/bounded-box-master.py",
} as const;

describe("bounded-box placement master bridge", () => {
  afterEach(() => {
    spawnSyncMock.mockReset();
    delete process.env["INDUSTRIAL_PLANNER_PYTHON"];
  });

  it("serializes only the satisfaction-model whitelist", () => {
    process.env["INDUSTRIAL_PLANNER_PYTHON"] = "bounded-python";
    spawnSyncMock.mockReturnValueOnce(processResult({
      status: "success",
      placements: [[
        { id: "a", x: 0, y: 0, width: 2, height: 3, rotation: 0 },
        { id: "b", x: 2, y: 0, width: 2, height: 2, rotation: 0 },
      ]],
      attemptedCandidates: 1,
      stoppedBy: "candidate-limit",
    }));

    solveBoundedBoxMaster({
      ...OPTIONS,
      devices: OPTIONS.devices.map((device) => ({
        ...device,
        escapeDepth: 3,
        recipeSignature: "must-not-cross-boundary",
      })),
      objectiveWeights: { boundingArea: 1_000_000 },
      learnedCuts: [{ id: "cut" }],
    } as unknown as Parameters<typeof solveBoundedBoxMaster>[0]);

    const input = JSON.parse(String(spawnSyncMock.mock.calls[0]?.[2]?.input)) as {
      devices: Array<Record<string, unknown>>;
      [key: string]: unknown;
    };
    expect(Object.keys(input).sort()).toEqual([
      "allowRotate",
      "boxHeight",
      "boxWidth",
      "candidateCount",
      "constraintProfile",
      "devices",
      "mapHeight",
      "mapWidth",
      "maxSeconds",
      "seed",
    ]);
    expect(input.devices[0]).toEqual({
      id: "a",
      width: 2,
      height: 3,
      hintPlacement: { x: 0, y: 0, rotation: 0 },
    });
  });

  it("keeps master infeasibility distinct from full routing UNSAT", () => {
    process.env["INDUSTRIAL_PLANNER_PYTHON"] = "bounded-python";
    spawnSyncMock.mockReturnValueOnce(processResult({
      status: "master-infeasible",
      stoppedBy: "exhausted",
    }));

    expect(solveBoundedBoxMaster(OPTIONS)).toMatchObject({
      constraintProfile: BOUNDED_BOX_MASTER_PROFILE,
      status: "master-infeasible",
      placements: [],
    });
  });

  it("rejects a witness that exceeds charged span or overlaps", () => {
    process.env["INDUSTRIAL_PLANNER_PYTHON"] = "bounded-python";
    spawnSyncMock.mockReturnValue(processResult({
      status: "success",
      placements: [[
        { id: "a", x: 0, y: 0, width: 2, height: 3, rotation: 0 },
        { id: "b", x: 1, y: 1, width: 2, height: 2, rotation: 0 },
      ]],
    }));

    expect(solveBoundedBoxMaster(OPTIONS)).toEqual({
      constraintProfile: BOUNDED_BOX_MASTER_PROFILE,
      status: "solver-failed",
      placements: [],
    });
  });

  it("drops an incumbent hint that cannot fit the smaller target height", () => {
    process.env["INDUSTRIAL_PLANNER_PYTHON"] = "bounded-python";
    spawnSyncMock.mockReturnValueOnce(processResult({
      status: "master-infeasible",
      stoppedBy: "exhausted",
    }));

    solveBoundedBoxMaster({
      ...OPTIONS,
      devices: [{ id: "a", width: 2, height: 3, hintPlacement: { x: 0, y: 3, rotation: 0 } }],
    });
    const input = JSON.parse(String(spawnSyncMock.mock.calls[0]?.[2]?.input)) as {
      devices: Array<Record<string, unknown>>;
    };
    expect(input.devices[0]).toEqual({ id: "a", width: 2, height: 3 });
  });

  it("does not accept a witness emitted by a failed subprocess", () => {
    spawnSyncMock.mockReturnValue({ ...processResult({
      status: "master-infeasible", stoppedBy: "exhausted",
    }), status: 1 });
    expect(solveBoundedBoxMaster(OPTIONS).status).toBe("solver-failed");
  });
});

function processResult(envelope: Record<string, unknown>) {
  return {
    status: 0,
    signal: null,
    stdout: JSON.stringify({
      constraintProfile: BOUNDED_BOX_MASTER_PROFILE,
      placements: [],
      pythonVersion: "3.13.9",
      orToolsVersion: "9.15.6755",
      ...envelope,
    }),
    stderr: "",
  };
}
