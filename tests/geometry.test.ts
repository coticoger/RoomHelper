import { describe, expect, it } from "vitest";
import {
  calculateScale,
  canPlaceFurniture,
  defaultProject,
  furnitureRect,
  isSimplePolygon,
  measureRealDistance,
  migrateProject,
  rectInsidePolygon,
  rectanglesOverlap,
  type CalibrationReference,
  type Furniture,
  type FloorScale,
} from "../shared/index";

const baseFurniture: Furniture = {
  id: "7f5d3d8b-25f1-4f3e-bd0e-0dd3b7a998c2",
  type: "table",
  name: "테이블",
  widthCm: 100,
  depthCm: 60,
  color: "#f2a45e",
  placement: null,
};

const scale: FloorScale = {
  pixelsPerCmX: 1,
  pixelsPerCmY: 1,
  xEstimated: false,
  yEstimated: false,
};

function projectWithRoom() {
  const project = defaultProject();
  project.floorPlan = {
    imageFileName: "room.png",
    imageWidthPx: 1000,
    imageHeightPx: 800,
    calibrationReferences: [],
    scale,
    measurements: [],
    zones: [],
  };
  return project;
}

describe("multi-reference scale", () => {
  it("calculates independent horizontal and vertical scales from every reference", () => {
    const references: CalibrationReference[] = [
      { id: "h1", axis: "horizontal", start: { x: 0, y: 10 }, end: { x: 100, y: 11 }, actualLengthCm: 100 },
      { id: "h2", axis: "horizontal", start: { x: 10, y: 20 }, end: { x: 190, y: 18 }, actualLengthCm: 200 },
      { id: "v1", axis: "vertical", start: { x: 30, y: 0 }, end: { x: 31, y: 400 }, actualLengthCm: 200 },
    ];
    expect(calculateScale(references)).toEqual({
      pixelsPerCmX: 280 / 300,
      pixelsPerCmY: 2,
      xEstimated: false,
      yEstimated: false,
    });
  });

  it("marks a missing axis as estimated from the available axis", () => {
    const result = calculateScale([
      { id: "h1", axis: "horizontal", start: { x: 0, y: 0 }, end: { x: 200, y: 0 }, actualLengthCm: 100 },
    ]);
    expect(result).toEqual({ pixelsPerCmX: 2, pixelsPerCmY: 2, xEstimated: false, yEstimated: true });
  });

  it("measures diagonal distances with different X/Y scales", () => {
    expect(measureRealDistance({ x: 0, y: 0 }, { x: 200, y: 300 }, {
      pixelsPerCmX: 2,
      pixelsPerCmY: 3,
      xEstimated: false,
      yEstimated: false,
    })).toBeCloseTo(Math.sqrt(20000));
  });
});

describe("furniture geometry", () => {
  it("uses independent X/Y scales for the furniture footprint", () => {
    const rect = furnitureRect({ ...baseFurniture, placement: { x: 200, y: 200, rotation: 0 } }, {
      pixelsPerCmX: 2,
      pixelsPerCmY: 3,
      xEstimated: false,
      yEstimated: false,
    });
    expect(rect).toEqual({ left: 100, top: 110, right: 300, bottom: 290 });
  });

  it("allows touching edges but rejects overlapping rectangles", () => {
    const first = { left: 0, top: 0, right: 100, bottom: 100 };
    expect(rectanglesOverlap(first, { left: 100, top: 0, right: 200, bottom: 100 })).toBe(false);
    expect(rectanglesOverlap(first, { left: 99, top: 0, right: 200, bottom: 100 })).toBe(true);
  });

  it("checks image bounds and existing furniture", () => {
    const project = projectWithRoom();
    expect(canPlaceFurniture(baseFurniture, { x: 100, y: 100, rotation: 0 }, project)).toBe(true);
    expect(canPlaceFurniture(baseFurniture, { x: 10, y: 10, rotation: 0 }, project)).toBe(false);
    project.furniture.push({ ...baseFurniture, id: "a5e4b385-9b5f-4bcb-858e-f2075f5eaf01", placement: { x: 300, y: 300, rotation: 0 } });
    expect(canPlaceFurniture(baseFurniture, { x: 340, y: 300, rotation: 0 }, project)).toBe(false);
  });

  it("requires the whole furniture rectangle to remain in one floor zone", () => {
    const project = projectWithRoom();
    project.floorPlan.zones = [
      { id: "room-1", name: "침실", points: [{ x: 50, y: 50 }, { x: 350, y: 50 }, { x: 350, y: 350 }, { x: 50, y: 350 }] },
      { id: "room-2", name: "거실", points: [{ x: 450, y: 50 }, { x: 800, y: 50 }, { x: 800, y: 350 }, { x: 450, y: 350 }] },
    ];
    expect(canPlaceFurniture(baseFurniture, { x: 150, y: 150, rotation: 0 }, project)).toBe(true);
    expect(canPlaceFurniture(baseFurniture, { x: 400, y: 150, rotation: 0 }, project)).toBe(false);
  });

  it("rejects a rectangle crossing the notch of a concave room", () => {
    const room = [
      { x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 300 },
      { x: 200, y: 300 }, { x: 200, y: 100 }, { x: 100, y: 100 },
      { x: 100, y: 300 }, { x: 0, y: 300 },
    ];
    expect(rectInsidePolygon({ left: 20, top: 20, right: 80, bottom: 80 }, room)).toBe(true);
    expect(rectInsidePolygon({ left: 50, top: 50, right: 250, bottom: 150 }, room)).toBe(false);
  });

  it("rejects self-intersecting floor-zone outlines", () => {
    expect(isSimplePolygon([{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }, { x: 100, y: 0 }])).toBe(false);
    expect(isSimplePolygon([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }])).toBe(true);
  });
});

describe("project migration", () => {
  it("preserves an out-of-bounds furniture placement so the UI can mark it invalid", () => {
    const project = projectWithRoom();
    project.floorPlan.calibrationReferences = [{
      id: "horizontal-reference",
      axis: "horizontal",
      start: { x: 0, y: 0 },
      end: { x: 100, y: 0 },
      actualLengthCm: 100,
    }];
    project.furniture = [{
      ...baseFurniture,
      placement: { x: 10, y: 10, rotation: 0 },
    }];

    const migrated = migrateProject(project);

    expect(migrated.furniture[0].placement).toEqual({ x: 10, y: 10, rotation: 0 });
    expect(canPlaceFurniture(migrated.furniture[0], migrated.furniture[0].placement!, migrated, migrated.furniture[0].id)).toBe(false);
  });

  it("migrates a v1 calibration without losing its scale", () => {
    const migrated = migrateProject({
      schemaVersion: 1,
      updatedAt: "2026-09-17T00:00:00.000Z",
      floorPlan: {
        imageFileName: "room.png",
        imageWidthPx: 1000,
        imageHeightPx: 800,
        calibration: {
          start: { x: 0, y: 0 },
          end: { x: 200, y: 0 },
          actualLengthCm: 100,
          pixelsPerCm: 2,
        },
      },
      furniture: [],
    });
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.floorPlan.scale?.pixelsPerCmX).toBe(2);
    expect(migrated.floorPlan.scale?.pixelsPerCmY).toBe(2);
    expect(migrated.floorPlan.calibrationReferences).toHaveLength(1);
  });

  it("normalizes likely millimetre values entered in the legacy cm-only field", () => {
    const migrated = migrateProject({
      schemaVersion: 1,
      updatedAt: "2026-09-17T00:00:00.000Z",
      floorPlan: {
        imageFileName: "room.png",
        imageWidthPx: 800,
        imageHeightPx: 454,
        calibration: {
          start: { x: 0, y: 0 },
          end: { x: 60, y: 0 },
          actualLengthCm: 1820,
          pixelsPerCm: 60 / 1820,
        },
      },
      furniture: [],
    });
    expect(migrated.floorPlan.calibrationReferences[0].actualLengthCm).toBe(182);
    expect(migrated.floorPlan.calibrationReferences[0].enteredUnit).toBe("mm");
    expect(migrated.floorPlan.calibrationReferences[0].enteredLength).toBe(1820);
    expect(migrated.floorPlan.scale?.pixelsPerCmX).toBeCloseTo(60 / 182);
  });
});
