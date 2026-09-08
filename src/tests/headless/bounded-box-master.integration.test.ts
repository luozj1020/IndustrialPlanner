import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { solveBoundedBoxMaster } from "@/headless/bounded-box-master";

const python = process.env["INDUSTRIAL_PLANNER_PYTHON"];
const describeWithOrTools = python === undefined ? describe.skip : describe;
const scriptPath = resolve(process.cwd(), "src/headless/bounded-box-master.py");

describeWithOrTools("bounded-box placement master with OR-Tools", () => {
  it("keeps equal-sized labeled rectangles interchangeable during SAT enumeration", () => {
    const result = solveBoundedBoxMaster({
      devices: [{ id: "item-A", width: 1, height: 1 }, { id: "item-B", width: 1, height: 1 }],
      mapWidth: 2, mapHeight: 1, boxWidth: 2, boxHeight: 1,
      allowRotate: false, maxSeconds: 2, candidateCount: 3, seed: 1, scriptPath,
    });
    expect(result.status).toBe("success");
    expect(result.placements).toHaveLength(2);
    expect(new Set(result.placements.map((p) => p.find((d) => d.id === "item-A")!.x))).toEqual(new Set([0, 1]));
    expect(result.stoppedBy).toBe("exhausted");
  }, 30_000);

  it("allows an uncharged warehouse hub outside a one-row charged box", () => {
    const result = solveBoundedBoxMaster({
      devices: [
        { id: "port", width: 3, height: 1, warehouseRole: "port", busEdges: { 0: "SOUTH" } },
        { id: "source", width: 4, height: 4, charged: false, warehouseRole: "source" },
        { id: "segment", width: 8, height: 4, charged: false, warehouseRole: "segment" },
      ],
      mapWidth: 16, mapHeight: 8, boxWidth: 3, boxHeight: 1,
      allowRotate: false, maxSeconds: 2, candidateCount: 1, seed: 2, scriptPath,
    });
    expect(result.status).toBe("success");
    const placement = result.placements[0]!;
    expect(placement.find((d) => d.id === "port")!.y).toBe(0);
    expect(placement.some((d) => d.y + d.height > 1)).toBe(true);
  }, 30_000);

  it("can mask spare ports while leaving the required cardinality accessible", () => {
    const result = solveBoundedBoxMaster({
      devices: [
        { id: "machine", width: 1, height: 1, portRequirements: [{ requiredCount: 1, ports: [
          { offsets: { 0: { x: -1, y: 0 } } }, { offsets: { 0: { x: 1, y: 0 } } },
        ] }] },
        { id: "neighbor", width: 1, height: 1 },
      ],
      mapWidth: 3, mapHeight: 1, boxWidth: 2, boxHeight: 1,
      allowRotate: false, maxSeconds: 2, candidateCount: 8, seed: 3, scriptPath,
    });
    expect(result.status).toBe("success");
    expect(result.placements.length).toBeGreaterThan(0);
    for (const placement of result.placements) {
      const machine = placement.find((d) => d.id === "machine")!;
      const neighbor = placement.find((d) => d.id === "neighbor")!;
      expect(machine.x).toBe(1);
      expect(Math.abs(machine.x - neighbor.x)).toBe(1);
    }
  }, 30_000);
  it("enumerates valid four-direction placement witnesses without an objective", () => {
    const result = solveBoundedBoxMaster({
      devices: [
        { id: "a", width: 2, height: 3 },
        { id: "b", width: 2, height: 2 },
      ],
      mapWidth: 6,
      mapHeight: 6,
      boxWidth: 4,
      boxHeight: 3,
      allowRotate: true,
      maxSeconds: 2,
      candidateCount: 3,
      seed: 17,
      scriptPath,
    });

    expect(result.status).toBe("success");
    expect(result.placements.length).toBeGreaterThan(0);
    expect(result.placements.length).toBeLessThanOrEqual(3);
    expect(result.placements.every((placement) => placement.length === 2)).toBe(true);
  }, 30_000);

  it("reports only placement-master infeasibility for an undersized box", () => {
    const result = solveBoundedBoxMaster({
      devices: [
        { id: "a", width: 2, height: 2 },
        { id: "b", width: 2, height: 2 },
      ],
      mapWidth: 4,
      mapHeight: 4,
      boxWidth: 2,
      boxHeight: 3,
      allowRotate: true,
      maxSeconds: 2,
      candidateCount: 1,
      seed: 19,
      scriptPath,
    });

    expect(result).toMatchObject({
      status: "master-infeasible",
      placements: [],
      stoppedBy: "exhausted",
    });
  }, 30_000);
});
