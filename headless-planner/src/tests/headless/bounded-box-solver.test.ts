import { describe, expect, it, vi } from "vitest";

import {
  BOUNDED_BOX_SAT_SEARCH_PROFILE,
  searchBetterBoundedBoxPlacements,
} from "../../headless/bounded-box-solver";
import type { BoundedBoxMasterResult } from "../../headless/bounded-box-master";

describe("bounded-box SAT search M1", () => {
  it("routes master witnesses and stops at the first strict improvement", () => {
    const evaluatedBoxes: string[] = [];
    const solveMaster = vi.fn((options): BoundedBoxMasterResult => ({
      constraintProfile: "bounded-box-placement-v1",
      status: "success",
      placements: [[{
        id: "machine",
        x: 0,
        y: 0,
        width: 2,
        height: 2,
        rotation: 0,
      }]],
      attemptedCandidates: 1,
      stoppedBy: "candidate-limit",
      elapsedMs: options.boxWidth,
    }));

    const result = searchBetterBoundedBoxPlacements({
      devices: [{ id: "machine", width: 2, height: 2 }],
      mapWidth: 8,
      mapHeight: 8,
      incumbentBox: { width: 5, height: 5 },
      incumbentArea: 25,
      minimumArea: 4,
      allowRotate: true,
      maxBoxes: 5,
      candidatesPerBox: 1,
      maxSecondsPerBox: 1,
      seed: 11,
      solveMaster,
      evaluatePlacement: ({ box }) => {
        evaluatedBoxes.push(`${box.width}x${box.height}`);
        return { routedWitness: true, improved: evaluatedBoxes.length === 2 };
      },
    });

    expect(result).toMatchObject({
      constraintProfile: BOUNDED_BOX_SAT_SEARCH_PROFILE,
      status: "improved",
      boxesAttempted: 2,
      masterPlacementsEvaluated: 2,
      routedWitnesses: 2,
      improvements: 1,
    });
    expect(solveMaster).toHaveBeenCalledTimes(2);
    expect(result.improvedBox).toBeDefined();
  });

  it("never promotes exhausted placement masters to full UNSAT", () => {
    const result = searchBetterBoundedBoxPlacements({
      devices: [{ id: "machine", width: 2, height: 2 }],
      mapWidth: 4,
      mapHeight: 4,
      incumbentBox: { width: 4, height: 4 },
      incumbentArea: 16,
      minimumArea: 4,
      allowRotate: true,
      maxBoxes: 3,
      seed: 1,
      solveMaster: (): BoundedBoxMasterResult => ({
        constraintProfile: "bounded-box-placement-v1",
        status: "master-infeasible",
        placements: [],
        stoppedBy: "exhausted",
      }),
      evaluatePlacement: () => {
        throw new Error("no placement should be routed");
      },
    });

    expect(result.status).toBe("no-routed-improvement");
    expect(result.masterStatusCounts["master-infeasible"]).toBe(result.boxesAttempted);
    expect(result.boxesAttempted).toBeGreaterThan(0);
    expect(result.routedWitnesses).toBe(0);
  });
});
