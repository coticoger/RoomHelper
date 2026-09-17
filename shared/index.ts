import { z } from "zod";

export const pointSchema = z.object({ x: z.number().finite(), y: z.number().finite() });
export const calibrationAxisSchema = z.enum(["horizontal", "vertical"]);

export const calibrationReferenceSchema = z.object({
  id: z.string().min(1).max(100),
  start: pointSchema,
  end: pointSchema,
  actualLengthCm: z.number().finite().positive().max(100000),
  enteredLength: z.number().finite().positive().max(1000000).optional(),
  enteredUnit: z.enum(["mm", "cm", "m"]).optional(),
  axis: calibrationAxisSchema,
}).refine((reference) => reference.axis === "horizontal"
  ? Math.abs(reference.end.x - reference.start.x) >= 1
  : Math.abs(reference.end.y - reference.start.y) >= 1, "축척 기준선의 두 점이 너무 가깝습니다.");

export const scaleSchema = z.object({
  pixelsPerCmX: z.number().finite().positive().max(100000),
  pixelsPerCmY: z.number().finite().positive().max(100000),
  xEstimated: z.boolean(),
  yEstimated: z.boolean(),
});

export const measurementSchema = z.object({
  id: z.string().min(1).max(100),
  start: pointSchema,
  end: pointSchema,
}).refine((measurement) => Math.hypot(measurement.end.x - measurement.start.x, measurement.end.y - measurement.start.y) >= 1, "측정선의 두 점이 너무 가깝습니다.");

export const floorZoneSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(80),
  points: z.array(pointSchema).min(3).max(100)
    .refine((points) => Math.abs(polygonArea(points)) >= 1, "배치 영역의 면적이 너무 작습니다.")
    .refine(isSimplePolygon, "배치 영역의 선이 서로 교차할 수 없습니다."),
});

export const furnitureTypeSchema = z.enum([
  "bed",
  "sofa",
  "table",
  "desk",
  "chair",
  "storage",
  "custom",
]);

export const placementSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
});

export const furnitureSchema = z.object({
  id: z.string().uuid(),
  type: furnitureTypeSchema,
  name: z.string().trim().min(1).max(80),
  widthCm: z.number().finite().positive().max(100000),
  depthCm: z.number().finite().positive().max(100000),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  placement: placementSchema.nullable(),
});

const floorPlanBaseSchema = z.object({
  imageFileName: z.string().regex(/^[a-zA-Z0-9._-]+$/).nullable(),
  imageWidthPx: z.number().int().positive().nullable(),
  imageHeightPx: z.number().int().positive().nullable(),
});

export const projectSchema = z.object({
  schemaVersion: z.literal(2),
  updatedAt: z.string().datetime(),
  floorPlan: floorPlanBaseSchema.extend({
    calibrationReferences: z.array(calibrationReferenceSchema).max(200).default([]),
    scale: scaleSchema.nullable().default(null),
    measurements: z.array(measurementSchema).max(500).default([]),
    zones: z.array(floorZoneSchema).max(100).default([]),
  }),
  furniture: z.array(furnitureSchema).max(500),
});

const legacyCalibrationSchema = z.object({
  start: pointSchema,
  end: pointSchema,
  actualLengthCm: z.number().finite().positive().max(100000),
  pixelsPerCm: z.number().finite().positive().max(100000),
});

const legacyProjectSchema = z.object({
  schemaVersion: z.literal(1),
  updatedAt: z.string().datetime(),
  floorPlan: floorPlanBaseSchema.extend({ calibration: legacyCalibrationSchema.nullable() }),
  furniture: z.array(furnitureSchema).max(500),
});

export type Point = z.infer<typeof pointSchema>;
export type CalibrationAxis = z.infer<typeof calibrationAxisSchema>;
export type CalibrationReference = z.infer<typeof calibrationReferenceSchema>;
export type FloorScale = z.infer<typeof scaleSchema>;
export type Measurement = z.infer<typeof measurementSchema>;
export type FloorZone = z.infer<typeof floorZoneSchema>;
export type FurnitureType = z.infer<typeof furnitureTypeSchema>;
export type Placement = z.infer<typeof placementSchema>;
export type Furniture = z.infer<typeof furnitureSchema>;
export type Project = z.infer<typeof projectSchema>;

export const defaultProject = (): Project => ({
  schemaVersion: 2,
  updatedAt: new Date().toISOString(),
  floorPlan: {
    imageFileName: null,
    imageWidthPx: null,
    imageHeightPx: null,
    calibrationReferences: [],
    scale: null,
    measurements: [],
    zones: [],
  },
  furniture: [],
});

export function classifyCalibrationAxis(start: Point, end: Point): CalibrationAxis {
  return Math.abs(end.x - start.x) >= Math.abs(end.y - start.y) ? "horizontal" : "vertical";
}

export function calibrationPixelLength(reference: Pick<CalibrationReference, "start" | "end" | "axis">): number {
  return reference.axis === "horizontal"
    ? Math.abs(reference.end.x - reference.start.x)
    : Math.abs(reference.end.y - reference.start.y);
}

export function calculateScale(references: CalibrationReference[]): FloorScale | null {
  if (references.length === 0) return null;

  const horizontal = references.filter((reference) => reference.axis === "horizontal" && calibrationPixelLength(reference) > 0);
  const vertical = references.filter((reference) => reference.axis === "vertical" && calibrationPixelLength(reference) > 0);
  const axisScale = (items: CalibrationReference[]) => {
    const actualTotal = items.reduce((sum, reference) => sum + reference.actualLengthCm, 0);
    const pixelTotal = items.reduce((sum, reference) => sum + calibrationPixelLength(reference), 0);
    return actualTotal > 0 ? pixelTotal / actualTotal : null;
  };

  const x = axisScale(horizontal);
  const y = axisScale(vertical);
  if (x === null && y === null) return null;
  return {
    pixelsPerCmX: x ?? y!,
    pixelsPerCmY: y ?? x!,
    xEstimated: x === null,
    yEstimated: y === null,
  };
}

export function measureRealDistance(start: Point, end: Point, scale: FloorScale): number {
  const widthCm = Math.abs(end.x - start.x) / scale.pixelsPerCmX;
  const heightCm = Math.abs(end.y - start.y) / scale.pixelsPerCmY;
  return Math.hypot(widthCm, heightCm);
}

export function migrateProject(input: unknown): Project {
  const current = projectSchema.safeParse(input);
  if (current.success) {
    return {
      ...current.data,
      floorPlan: {
        ...current.data.floorPlan,
        scale: calculateScale(current.data.floorPlan.calibrationReferences),
      },
    };
  }

  const legacy = legacyProjectSchema.parse(input);
  const calibration = legacy.floorPlan.calibration;
  const longestImageSide = Math.max(legacy.floorPlan.imageWidthPx ?? 0, legacy.floorPlan.imageHeightPx ?? 0);
  const looksLikeLegacyMillimetres = Boolean(
    calibration
    && calibration.actualLengthCm >= 1000
    && longestImageSide / calibration.pixelsPerCm > 10000,
  );
  const legacyUnitFactor = looksLikeLegacyMillimetres ? 10 : 1;
  const references: CalibrationReference[] = calibration
    ? [{
        id: "legacy-calibration",
        start: calibration.start,
        end: calibration.end,
        actualLengthCm: calibration.actualLengthCm / legacyUnitFactor,
        enteredLength: calibration.actualLengthCm,
        enteredUnit: looksLikeLegacyMillimetres ? "mm" : "cm",
        axis: classifyCalibrationAxis(calibration.start, calibration.end),
      }]
    : [];
  return {
    schemaVersion: 2,
    updatedAt: legacy.updatedAt,
    floorPlan: {
      imageFileName: legacy.floorPlan.imageFileName,
      imageWidthPx: legacy.floorPlan.imageWidthPx,
      imageHeightPx: legacy.floorPlan.imageHeightPx,
      calibrationReferences: references,
      scale: calculateScale(references),
      measurements: [],
      zones: [],
    },
    furniture: legacy.furniture,
  };
}

export function footprintSize(furniture: Pick<Furniture, "widthCm" | "depthCm"> & { placement?: Pick<Placement, "rotation"> | null }) {
  const rotation = furniture.placement?.rotation ?? 0;
  const rotated = rotation === 90 || rotation === 270;
  return {
    widthCm: rotated ? furniture.depthCm : furniture.widthCm,
    depthCm: rotated ? furniture.widthCm : furniture.depthCm,
  };
}

export type Rect = { left: number; top: number; right: number; bottom: number };

export function furnitureRect(
  furniture: Pick<Furniture, "widthCm" | "depthCm"> & { placement: Pick<Placement, "x" | "y" | "rotation"> },
  scale: FloorScale,
): Rect {
  const size = footprintSize(furniture);
  const width = size.widthCm * scale.pixelsPerCmX;
  const height = size.depthCm * scale.pixelsPerCmY;
  return {
    left: furniture.placement.x - width / 2,
    top: furniture.placement.y - height / 2,
    right: furniture.placement.x + width / 2,
    bottom: furniture.placement.y + height / 2,
  };
}

export function rectanglesOverlap(a: Rect, b: Rect, epsilon = 0.0001): boolean {
  return a.left < b.right - epsilon && a.right > b.left + epsilon && a.top < b.bottom - epsilon && a.bottom > b.top + epsilon;
}

function pointOnSegment(point: Point, start: Point, end: Point, epsilon = 0.0001): boolean {
  const cross = (point.y - start.y) * (end.x - start.x) - (point.x - start.x) * (end.y - start.y);
  if (Math.abs(cross) > epsilon) return false;
  return point.x >= Math.min(start.x, end.x) - epsilon
    && point.x <= Math.max(start.x, end.x) + epsilon
    && point.y >= Math.min(start.y, end.y) - epsilon
    && point.y <= Math.max(start.y, end.y) + epsilon;
}

export function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const start = polygon[previous];
    const end = polygon[index];
    if (pointOnSegment(point, start, end)) return true;
    const crossesRay = (end.y > point.y) !== (start.y > point.y)
      && point.x < ((start.x - end.x) * (point.y - end.y)) / (start.y - end.y) + end.x;
    if (crossesRay) inside = !inside;
  }
  return inside;
}

function crossProduct(a: Point, b: Point, c: Point) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function segmentsProperlyIntersect(a: Point, b: Point, c: Point, d: Point, epsilon = 0.0001) {
  const abC = crossProduct(a, b, c);
  const abD = crossProduct(a, b, d);
  const cdA = crossProduct(c, d, a);
  const cdB = crossProduct(c, d, b);
  return abC * abD < -epsilon && cdA * cdB < -epsilon;
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point, epsilon = 0.0001) {
  if (segmentsProperlyIntersect(a, b, c, d, epsilon)) return true;
  return (Math.abs(crossProduct(a, b, c)) <= epsilon && pointOnSegment(c, a, b, epsilon))
    || (Math.abs(crossProduct(a, b, d)) <= epsilon && pointOnSegment(d, a, b, epsilon))
    || (Math.abs(crossProduct(c, d, a)) <= epsilon && pointOnSegment(a, c, d, epsilon))
    || (Math.abs(crossProduct(c, d, b)) <= epsilon && pointOnSegment(b, c, d, epsilon));
}

export function polygonArea(points: Point[]): number {
  return points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0) / 2;
}

export function isSimplePolygon(points: Point[]): boolean {
  if (points.length < 3) return false;
  for (let first = 0; first < points.length; first += 1) {
    for (let second = first + 1; second < points.length; second += 1) {
      if (Math.hypot(points[first].x - points[second].x, points[first].y - points[second].y) < 0.0001) return false;
    }
  }
  for (let first = 0; first < points.length; first += 1) {
    const firstNext = (first + 1) % points.length;
    for (let second = first + 1; second < points.length; second += 1) {
      const secondNext = (second + 1) % points.length;
      const adjacent = first === second || firstNext === second || secondNext === first;
      if (adjacent) continue;
      if (segmentsIntersect(points[first], points[firstNext], points[second], points[secondNext])) return false;
    }
  }
  return true;
}

export function rectInsidePolygon(rect: Rect, polygon: Point[]): boolean {
  if (polygon.length < 3) return false;
  const corners: Point[] = [
    { x: rect.left, y: rect.top },
    { x: rect.right, y: rect.top },
    { x: rect.right, y: rect.bottom },
    { x: rect.left, y: rect.bottom },
  ];
  const center = { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
  if (![...corners, center].every((point) => pointInPolygon(point, polygon))) return false;

  const rectEdges = corners.map((corner, index) => [corner, corners[(index + 1) % corners.length]] as const);
  for (let index = 0; index < polygon.length; index += 1) {
    const polygonEdge = [polygon[index], polygon[(index + 1) % polygon.length]] as const;
    if (rectEdges.some(([start, end]) => segmentsProperlyIntersect(start, end, polygonEdge[0], polygonEdge[1]))) return false;
  }
  return true;
}

export function canPlaceFurniture(
  candidate: Furniture,
  placement: Placement,
  project: Pick<Project, "floorPlan" | "furniture">,
  ignoreId?: string,
): boolean {
  const { imageWidthPx, imageHeightPx, scale, zones } = project.floorPlan;
  if (!imageWidthPx || !imageHeightPx || !scale) return false;

  const candidateRect = furnitureRect({ ...candidate, placement }, scale);
  const inBounds = candidateRect.left >= -0.0001 && candidateRect.top >= -0.0001 && candidateRect.right <= imageWidthPx + 0.0001 && candidateRect.bottom <= imageHeightPx + 0.0001;
  if (!inBounds) return false;
  if (zones.length > 0 && !zones.some((zone) => rectInsidePolygon(candidateRect, zone.points))) return false;

  return project.furniture.every((other) => {
    if (other.id === ignoreId || !other.placement) return true;
    return !rectanglesOverlap(candidateRect, furnitureRect({ ...other, placement: other.placement }, scale));
  });
}
