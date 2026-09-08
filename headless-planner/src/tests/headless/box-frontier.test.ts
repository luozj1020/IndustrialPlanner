import { describe, expect, it } from "vitest";

import {
  createParetoMaximalBoxFrontier,
  dominatesBox,
  orderBoxFrontierForWarmStart,
} from "../../headless/box-frontier";

describe("bounded-box Pareto frontier", () => {
  it("covers every smaller box and matches exhaustive maximality on tiny maps", () => {
    for (let width = 1; width <= 8; width += 1) {
      for (let height = 1; height <= 8; height += 1) {
        for (let cap = 0; cap <= width * height; cap += 1) {
          const all = Array.from({ length: width }, (_, x) =>
            Array.from({ length: height }, (_, y) => ({ width: x + 1, height: y + 1, area: (x + 1) * (y + 1) })))
            .flat().filter((box) => box.area <= cap);
          const exact = all.filter((box) => !all.some((other) => dominatesBox(other, box)));
          expect(createParetoMaximalBoxFrontier({ maxArea: cap, maxWidth: width, maxHeight: height })).toEqual(exact);
        }
      }
    }
  });
  it("enumerates only componentwise-maximal integer boxes", () => {
    const frontier = createParetoMaximalBoxFrontier({
      maxArea: 10,
      maxWidth: 10,
      maxHeight: 10,
    });

    expect(frontier).toEqual([
      { width: 1, height: 10, area: 10 },
      { width: 2, height: 5, area: 10 },
      { width: 3, height: 3, area: 9 },
      { width: 5, height: 2, area: 10 },
      { width: 10, height: 1, area: 10 },
    ]);
    expect(frontier.every((candidate) =>
      frontier.every((other) => candidate === other || !dominatesBox(other, candidate))))
      .toBe(true);
  });

  it("honors map, minimum-dimension, and safe area floors", () => {
    expect(createParetoMaximalBoxFrontier({
      maxArea: 30,
      maxWidth: 6,
      maxHeight: 4,
      minArea: 20,
      minWidth: 3,
      minHeight: 2,
    })).toEqual([{ width: 6, height: 4, area: 24 }]);

    expect(createParetoMaximalBoxFrontier({
      maxArea: 19,
      maxWidth: 6,
      maxHeight: 4,
      minArea: 20,
    })).toEqual([]);
  });

  it("orders SAT attempts near the routed incumbent without changing membership", () => {
    const frontier = createParetoMaximalBoxFrontier({
      maxArea: 329,
      maxWidth: 30,
      maxHeight: 30,
    });
    const ordered = orderBoxFrontierForWarmStart(frontier, { width: 15, height: 22 });

    expect(ordered[0]).toEqual({ width: 15, height: 21, area: 315 });
    expect(new Set(ordered.map(({ width, height }) => `${width}x${height}`))).toEqual(
      new Set(frontier.map(({ width, height }) => `${width}x${height}`)),
    );
  });

  it("rejects unsafe numeric domains", () => {
    expect(() => createParetoMaximalBoxFrontier({
      maxArea: 10,
      maxWidth: 0,
      maxHeight: 10,
    })).toThrow(/maxWidth/);
  });
});
