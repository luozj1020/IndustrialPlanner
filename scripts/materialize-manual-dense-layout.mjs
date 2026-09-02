import { readFile, writeFile } from "node:fs/promises";

const sourcePath = process.argv[2] ?? "/tmp/dense-sixway-blueprint.json";
const outputPath = process.argv[3] ?? "examples/headless/manual-dense-equipment-blueprint.json";

// Hand-authored placement table. This script only materializes the drawing; it
// performs no search, scoring, packing, or routing.
const placements = {
  "cycle-moss-planter-1": [0, 0, 90],
  "cycle-moss-seed-collector-1": [0, 6, 270],
  "cycle-moss-planter-2": [0, 12, 90],
  "warehouse-storage-1": [6, 7, 270],
  "opt-6-1": [10, 0, 270],
  "opt-6-2": [10, 6, 270],
  "opt-6-3": [10, 12, 270],
  "opt-2-1": [17, 0, 270],
  "opt-2-2": [17, 3, 270],
  "opt-2-3": [17, 6, 270],
  "opt-2-4": [17, 9, 270],
  "opt-2-5": [17, 12, 270],
  "opt-2-6": [17, 15, 270],
  "opt-1-1": [14, 18, 0],
  "warehouse-unloader-1": [21, 1, 90],
  "warehouse-unloader-2": [21, 4, 90],
  "warehouse-unloader-3": [21, 7, 90],
  "warehouse-unloader-4": [21, 10, 90],
  "warehouse-unloader-5": [21, 13, 90],
  "warehouse-unloader-6": [21, 16, 90],
  "warehouse-bus-source": [22, 0, 0],
  "warehouse-bus-1": [22, 4, 0],
  "warehouse-bus-2": [22, 12, 0],
  "warehouse-bus-3": [22, 20, 0],
};

const blueprint = JSON.parse(await readFile(sourcePath, "utf8"));
const entityOrder = Object.keys(placements);
const entities = Object.fromEntries(entityOrder.map((id) => {
  const source = blueprint.entities[id];
  if (source === undefined) throw new Error(`Missing source entity: ${id}`);
  const [x, y, rotation] = placements[id];
  return [id, { ...source, position: { x, y }, rotation }];
}));

const manual = {
  ...blueprint,
  blueprintId: "manual-dense-equipment-v1",
  name: "Manual triple dense originium equipment layout v1",
  description: "Hand-planned equipment-only layout for three independent full-speed moss-powder lanes. Logistics intentionally omitted.",
  entities,
  entityOrder,
};
await writeFile(outputPath, `${JSON.stringify(manual, null, 2)}\n`, "utf8");
