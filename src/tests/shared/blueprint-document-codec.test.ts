import { describe, expect, it } from "vitest";
import { createBlueprintDocument } from "@/domain/document/blueprint-document";
import { normalizeBlueprintDocument } from "@/shared/blueprints/blueprint-document-codec";

function fixture() {
  return createBlueprintDocument({
    name: "Valid", baseId: "base", initialGridPoint: { x: 0, y: 0 },
    entities: { e: { id: "e", definitionId: "device", position: { x: -2, y: 1 }, rotation: 90, config: {}, tags: [] } },
    entityOrder: ["e"], slotLinks: [],
  });
}

describe("blueprint import structure", () => {
  it("accepts a complete document including negative grid positions", () => {
    const document = fixture();
    expect(normalizeBlueprintDocument(document)).toEqual(document);
  });

  it.each([
    { entities: { e: {} } }, { entities: { e: null } }, { entities: [] },
    { slotLinks: [null] }, { entityOrder: ["missing"] }, { entityOrder: ["e", "e"] },
    { initialGridPoint: { x: Infinity, y: 0 } }, { schemaVersion: 99 },
  ])("rejects malformed nested structure %j", (patch) => {
    expect(normalizeBlueprintDocument({ ...fixture(), ...patch })).toBeNull();
  });

  it("rejects invalid rotations, tags, coordinates, IDs and config", () => {
    for (const patch of [{ rotation: 45 }, { tags: null }, { config: [] }, { position: { x: 0.5, y: 0 } }, { id: "wrong" }]) {
      const document = fixture();
      expect(normalizeBlueprintDocument({ ...document, entities: { e: { ...document.entities.e, ...patch } } })).toBeNull();
    }
  });

  it("validates slot link endpoints and unique link IDs", () => {
    const document = fixture();
    const link = { id: "link", linkType: "share-all", source: { entityId: "e", storageSlotGroupId: "group", slotId: "slot" }, target: { entityId: "e", storageSlotGroupId: "other", slotId: "slot" } };
    expect(normalizeBlueprintDocument({ ...document, slotLinks: [link] })).not.toBeNull();
    expect(normalizeBlueprintDocument({ ...document, slotLinks: [link, link] })).toBeNull();
    expect(normalizeBlueprintDocument({ ...document, slotLinks: [{ ...link, target: { ...link.target, entityId: "absent" } }] })).toBeNull();
    for (const entityId of ["warehouse", "warehouse:base", "base-builtin:core"]) {
      expect(normalizeBlueprintDocument({ ...document, slotLinks: [{ ...link, target: { ...link.target, entityId } }] })).not.toBeNull();
    }
  });
});
