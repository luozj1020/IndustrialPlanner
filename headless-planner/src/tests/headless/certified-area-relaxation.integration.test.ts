import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  solveCpSatAreaLowerBound,
  type CertifiedAreaRelaxationDevice,
} from "../../headless/certified-area-relaxation";
import { optimizeHeadlessLayout } from "../../headless/layout-optimizer";
import { createRegistryContract } from "../../registry";

const ortoolsPython = findOrToolsPython();
const previousPython = process.env["INDUSTRIAL_PLANNER_PYTHON"];
const certifiedScriptPath = resolve(process.cwd(), "src/headless/certified-area-relaxation.py");

describe.skipIf(ortoolsPython === undefined)("certified area relaxation exact oracle", () => {
  beforeAll(() => {
    process.env["INDUSTRIAL_PLANNER_PYTHON"] = ortoolsPython;
  });

  afterAll(() => {
    if (previousPython === undefined) delete process.env["INDUSTRIAL_PLANNER_PYTHON"];
    else process.env["INDUSTRIAL_PLANNER_PYTHON"] = previousPython;
  });

  it.each([
    {
      devices: [
        { id: "a", width: 2, height: 3 },
        { id: "b", width: 3, height: 1 },
      ],
      limitWidth: 5,
      limitHeight: 5,
      allowRotate: true,
      expected: 9,
    },
    {
      devices: [
        { id: "a", width: 2, height: 2 },
        { id: "b", width: 2, height: 2 },
        { id: "c", width: 1, height: 3 },
      ],
      limitWidth: 3,
      limitHeight: 5,
      allowRotate: false,
      expected: 12,
    },
    {
      devices: [
        { id: "a", width: 1, height: 4 },
        { id: "b", width: 2, height: 2 },
      ],
      limitWidth: 4,
      limitHeight: 3,
      allowRotate: true,
      expected: 12,
    },
    {
      devices: [
        { id: "z", width: 2, height: 1 },
        { id: "a", width: 2, height: 1 },
        { id: "m", width: 2, height: 1 },
        { id: "b", width: 2, height: 1 },
      ],
      limitWidth: 4,
      limitHeight: 2,
      allowRotate: true,
      expected: 8,
    },
  ] as const)("matches exhaustive placement optimum $expected", (testCase) => {
    const oracle = exactAreaOracle(testCase);
    expect(oracle).toBe(testCase.expected);

    const result = solveCpSatAreaLowerBound({
      ...testCase,
      maxSeconds: 2,
      scriptPath: certifiedScriptPath,
    });
    expect(result.status).toBe("optimal");
    expect(result.certifiedIntegerLowerBound).toBe(oracle);
    expect(result.masterIncumbentArea).toBe(oracle);
  }, 30_000);

  it("proves the relaxation infeasible when no orientation fits", () => {
    const problem = {
      devices: [
        { id: "a", width: 1, height: 4 },
        { id: "b", width: 2, height: 2 },
      ],
      limitWidth: 4,
      limitHeight: 3,
      allowRotate: false,
    } as const;
    expect(exactAreaOracle(problem)).toBeNull();
    expect(solveCpSatAreaLowerBound({
      ...problem,
      maxSeconds: 2,
      scriptPath: certifiedScriptPath,
    }).status).toBe("infeasible");
  }, 30_000);

  it("stays below an exact placement-plus-routing oracle", () => {
    const devices = [
      { id: "source", width: 1, height: 1 },
      { id: "target", width: 1, height: 1 },
    ] as const;
    const exactFullArea = exactSingleLaneFullAreaOracle({
      limitWidth: 4,
      limitHeight: 3,
    });
    expect(exactFullArea).toBe(3);
    if (exactFullArea === null) throw new Error("Exact full oracle unexpectedly found no route");

    const result = solveCpSatAreaLowerBound({
      devices,
      limitWidth: 4,
      limitHeight: 3,
      allowRotate: false,
      maxSeconds: 2,
      scriptPath: certifiedScriptPath,
    });
    const routedUpperBound = 3;
    expect(result.status).toBe("optimal");
    expect(result.certifiedIntegerLowerBound).toBe(2);
    expect(result.certifiedIntegerLowerBound!).toBeLessThanOrEqual(exactFullArea);
    expect(exactFullArea).toBeLessThanOrEqual(routedUpperBound);
  }, 30_000);

  it("feeds the proof bound into a strict routed HeadlessOptimizationResult", () => {
    const result = optimizeHeadlessLayout({
      width: 32,
      height: 32,
      targets: [{ itemId: "item_iron_nugget", perMinute: 60 }],
      search: { iterations: 0, routingVariants: 1, seed: 42 },
      certification: { boundingArea: { maxSeconds: 2 } },
    }, createRegistryContract());
    const area = result.optimality.boundingArea;

    expect(["optimal", "feasible"]).toContain(area.proof.solverStatus);
    expect(area.proof.certifiedIntegerLowerBound).toBeDefined();
    expect(area.lowerBoundSources.cpSatArea).toBe(area.proof.certifiedIntegerLowerBound);
    expect(area.lowerBound).toBe(Math.max(
      area.lowerBoundSources.mandatoryDeviceArea!,
      area.lowerBoundSources.cpSatArea!,
    ));
    expect(area.strictRoutedUpperBoundVerified).toBe(true);
    expect(area.upperBound).toBe(result.layout.boundingArea);
    expect(area.lowerBound).toBeLessThanOrEqual(area.upperBound!);
    expect(area.proof.masterIncumbentArea).not.toBe(area.upperBound);
  }, 60_000);
});

function findOrToolsPython(): string | undefined {
  const candidates = [
    process.env["INDUSTRIAL_PLANNER_PYTHON"],
    resolve(process.cwd(), ".venv-headless/bin/python"),
    resolve(process.cwd(), "../.venv-headless/bin/python"),
  ].filter((candidate, index, all): candidate is string =>
    candidate !== undefined && existsSync(candidate) && all.indexOf(candidate) === index);
  return candidates.find((candidate) =>
    spawnSync(candidate, ["-c", "import ortools"], { stdio: "ignore" }).status === 0);
}

function exactAreaOracle(options: {
  readonly devices: readonly CertifiedAreaRelaxationDevice[];
  readonly limitWidth: number;
  readonly limitHeight: number;
  readonly allowRotate: boolean;
}): number | null {
  const placements: Array<{
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }> = [];
  let best = Number.POSITIVE_INFINITY;
  const search = (index: number): void => {
    if (index === options.devices.length) {
      const minimumX = Math.min(...placements.map((placement) => placement.x));
      const maximumX = Math.max(...placements.map((placement) => placement.x + placement.width));
      const maximumY = Math.max(...placements.map((placement) => placement.y + placement.height));
      best = Math.min(best, (maximumX - minimumX) * maximumY);
      return;
    }
    const device = options.devices[index]!;
    const orientations = options.allowRotate && device.width !== device.height
      ? [[device.width, device.height], [device.height, device.width]] as const
      : [[device.width, device.height]] as const;
    for (const [width, height] of orientations) {
      for (let y = 0; y <= options.limitHeight - height; y += 1) {
        for (let x = 0; x <= options.limitWidth - width; x += 1) {
          const candidate = { x, y, width, height };
          if (placements.some((placement) => rectanglesOverlap(placement, candidate))) continue;
          placements.push(candidate);
          search(index + 1);
          placements.pop();
        }
      }
    }
  };
  search(0);
  return Number.isFinite(best) ? best : null;
}

function rectanglesOverlap(
  left: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  right: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
): boolean {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

/** Exact tiny full-problem oracle: two 1x1 devices and one east-to-west grid lane. */
function exactSingleLaneFullAreaOracle(options: {
  readonly limitWidth: number;
  readonly limitHeight: number;
}): number | null {
  let best = Number.POSITIVE_INFINITY;
  for (let sourceY = 0; sourceY < options.limitHeight; sourceY += 1) {
    for (let sourceX = 0; sourceX < options.limitWidth; sourceX += 1) {
      for (let targetY = 0; targetY < options.limitHeight; targetY += 1) {
        for (let targetX = 0; targetX < options.limitWidth; targetX += 1) {
          if (sourceX === targetX && sourceY === targetY) continue;
          const start = { x: sourceX + 1, y: sourceY };
          const goal = { x: targetX - 1, y: targetY };
          const deviceCells = new Set([`${sourceX},${sourceY}`, `${targetX},${targetY}`]);
          if (!inBounds(start, options) || !inBounds(goal, options)
            || deviceCells.has(gridKey(start)) || deviceCells.has(gridKey(goal))) continue;
          const path = [start];
          const visited = new Set([gridKey(start)]);
          const enumeratePaths = (point: { readonly x: number; readonly y: number }): void => {
            if (point.x === goal.x && point.y === goal.y) {
              const cells = [
                { x: sourceX, y: sourceY },
                { x: targetX, y: targetY },
                ...path,
              ];
              const minimumX = Math.min(...cells.map((cell) => cell.x));
              const maximumX = Math.max(...cells.map((cell) => cell.x + 1));
              const maximumY = Math.max(...cells.map((cell) => cell.y + 1));
              best = Math.min(best, (maximumX - minimumX) * maximumY);
              return;
            }
            for (const delta of [
              { x: 1, y: 0 },
              { x: 0, y: 1 },
              { x: -1, y: 0 },
              { x: 0, y: -1 },
            ]) {
              const next = { x: point.x + delta.x, y: point.y + delta.y };
              const key = gridKey(next);
              if (!inBounds(next, options) || deviceCells.has(key) || visited.has(key)) continue;
              visited.add(key);
              path.push(next);
              enumeratePaths(next);
              path.pop();
              visited.delete(key);
            }
          };
          enumeratePaths(start);
        }
      }
    }
  }
  return Number.isFinite(best) ? best : null;
}

function inBounds(
  point: { readonly x: number; readonly y: number },
  bounds: { readonly limitWidth: number; readonly limitHeight: number },
): boolean {
  return point.x >= 0 && point.y >= 0
    && point.x < bounds.limitWidth && point.y < bounds.limitHeight;
}

function gridKey(point: { readonly x: number; readonly y: number }): string {
  return `${point.x},${point.y}`;
}
