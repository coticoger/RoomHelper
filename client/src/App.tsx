import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Group, Image as KonvaImage, Layer, Line, Rect, Stage, Text, Circle } from "react-konva";
import type { CalibrationReference, Furniture, FurnitureType, Point, Placement, Project } from "@roomhelper/shared";
import { calibrationPixelLength, calculateScale, canPlaceFurniture, classifyCalibrationAxis, defaultProject, footprintSize, isSimplePolygon, measureRealDistance, polygonArea } from "@roomhelper/shared";

const furnitureTypes: Array<{ value: FurnitureType; label: string; color: string }> = [
  { value: "bed", label: "침대", color: "#6f83ff" },
  { value: "sofa", label: "소파", color: "#a779ff" },
  { value: "table", label: "테이블", color: "#f2a45e" },
  { value: "desk", label: "책상", color: "#36b7a5" },
  { value: "chair", label: "의자", color: "#ec7590" },
  { value: "storage", label: "수납장", color: "#e0bd59" },
  { value: "custom", label: "직접 입력", color: "#8e99aa" },
];

type SaveStatus = "loading" | "saving" | "saved" | "error";
type Preview = { id: string; placement: Placement; valid: boolean } | null;
type CanvasMode = "idle" | "calibrate" | "measure" | "zone";

async function api<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const data = (await response.json().catch(() => ({}))) as T & { message?: string };
  if (!response.ok) throw new Error(data.message ?? "요청을 처리하지 못했습니다.");
  return data;
}

function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function readImageDimensions(file: File) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(file);
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("이미지를 읽을 수 없습니다."));
    };
    image.src = objectUrl;
  });
}

function useFloorImage(fileName: string | null) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!fileName) {
      setImage(null);
      return;
    }
    const nextImage = new Image();
    nextImage.onload = () => setImage(nextImage);
    nextImage.onerror = () => setImage(null);
    const [name, query] = fileName.split("?");
    nextImage.src = `/api/floor-plan/${encodeURIComponent(name)}${query ? `?${query}` : ""}`;
  }, [fileName]);
  return image;
}

function typeLabel(type: FurnitureType) {
  return furnitureTypes.find((item) => item.value === type)?.label ?? "가구";
}

function App() {
  const [project, setProject] = useState<Project>(defaultProject);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [canvasMode, setCanvasMode] = useState<CanvasMode>("idle");
  const [drawingPoints, setDrawingPoints] = useState<Point[]>([]);
  const [actualLength, setActualLength] = useState("");
  const [calibrationUnit, setCalibrationUnit] = useState<"mm" | "cm" | "m">("mm");
  const [zoneName, setZoneName] = useState("");
  const [zoom, setZoom] = useState(1);
  const [preview, setPreview] = useState<Preview>(null);
  const [newFurniture, setNewFurniture] = useState({
    type: "bed" as FurnitureType,
    name: "침대",
    widthCm: "200",
    depthCm: "160",
  });
  const [isAdding, setIsAdding] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [imageVersion, setImageVersion] = useState(0);
  const readyRef = useRef(false);
  const stageWrapRef = useRef<HTMLDivElement>(null);
  const image = useFloorImage(project.floorPlan.imageFileName ? `${project.floorPlan.imageFileName}?v=${imageVersion}` : null);

  useEffect(() => {
    api<Project>("/api/project")
      .then((loaded) => {
        setProject(loaded);
        readyRef.current = true;
        setSaveStatus("saved");
      })
      .catch((error: Error) => {
        setLoadError(error.message);
        setSaveStatus("error");
      });
  }, []);

  useEffect(() => {
    if (!readyRef.current) return;
    setSaveStatus("saving");
    const timer = window.setTimeout(() => {
      api<Project>("/api/project", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(project),
      })
        .then(() => setSaveStatus("saved"))
        .catch(() => setSaveStatus("error"));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [project]);

  useEffect(() => {
    if (!showHelp) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowHelp(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [showHelp]);

  const floorSize = project.floorPlan.imageWidthPx && project.floorPlan.imageHeightPx
    ? { width: project.floorPlan.imageWidthPx, height: project.floorPlan.imageHeightPx }
    : null;
  const viewScale = useMemo(() => {
    if (!floorSize) return 1;
    const fit = Math.min(1, 940 / floorSize.width, 610 / floorSize.height);
    return fit * zoom;
  }, [floorSize, zoom]);
  const stageSize = floorSize
    ? { width: Math.max(1, Math.round(floorSize.width * viewScale)), height: Math.max(1, Math.round(floorSize.height * viewScale)) }
    : { width: 720, height: 500 };
  const selectedFurniture = project.furniture.find((item) => item.id === selectedId) ?? null;

  const updateFurniture = useCallback((id: string, updater: (furniture: Furniture) => Furniture) => {
    setProject((current) => ({ ...current, furniture: current.furniture.map((item) => item.id === id ? updater(item) : item) }));
  }, []);

  const canvasPoint = useCallback((clientX: number, clientY: number): Point | null => {
    const wrapper = stageWrapRef.current;
    if (!wrapper) return null;
    const bounds = wrapper.querySelector("canvas")?.getBoundingClientRect() ?? wrapper.getBoundingClientRect();
    return { x: (clientX - bounds.left) / viewScale, y: (clientY - bounds.top) / viewScale };
  }, [viewScale]);

  const handleCanvasClick = (event: { target: { getStage?: () => unknown }; evt: MouseEvent }) => {
    if (canvasMode === "idle" || !floorSize) return;
    const point = canvasPoint(event.evt.clientX, event.evt.clientY);
    if (!point) return;
    if (canvasMode === "zone") {
      setDrawingPoints((points) => [...points, point]);
      return;
    }
    if (drawingPoints.length === 0) {
      setDrawingPoints([point]);
      return;
    }
    const points: [Point, Point] = [drawingPoints[0], point];
    if (canvasMode === "measure") {
      if (distance(points[0], points[1]) < 1) {
        setNotice("길이를 재려면 서로 다른 두 점을 선택해 주세요.");
        return;
      }
      const scale = project.floorPlan.scale;
      if (!scale) {
        setNotice("길이를 재기 전에 축척 기준선을 하나 이상 등록해 주세요.");
        return;
      }
      const measured = measureRealDistance(points[0], points[1], scale);
      setProject((current) => ({
        ...current,
        floorPlan: {
          ...current.floorPlan,
          measurements: [...current.floorPlan.measurements, { id: crypto.randomUUID(), start: points[0], end: points[1] }],
        },
      }));
      setDrawingPoints([]);
      setCanvasMode("idle");
      setNotice(`선택한 구간은 약 ${measured.toFixed(1)}cm입니다.`);
      return;
    }
    setDrawingPoints(points);
  };

  const applyCalibration = () => {
    const inputLength = Number(actualLength);
    const lengthCm = calibrationUnit === "mm" ? inputLength / 10 : calibrationUnit === "m" ? inputLength * 100 : inputLength;
    if (drawingPoints.length !== 2 || !Number.isFinite(lengthCm) || lengthCm <= 0) {
      setNotice("도면에서 두 점을 선택하고 실제 길이를 cm로 입력해 주세요.");
      return;
    }
    const axis = classifyCalibrationAxis(drawingPoints[0], drawingPoints[1]);
    const reference: CalibrationReference = {
      id: crypto.randomUUID(),
      start: drawingPoints[0],
      end: drawingPoints[1],
      actualLengthCm: lengthCm,
      enteredLength: inputLength,
      enteredUnit: calibrationUnit,
      axis,
    };
    const pixelDistance = calibrationPixelLength(reference);
    if (pixelDistance < 1) {
      setNotice(`${axis === "horizontal" ? "가로" : "세로"} 방향으로 서로 다른 두 점을 선택해 주세요.`);
      return;
    }
    setProject((current) => {
      const floorPlan = {
        ...current.floorPlan,
        calibrationReferences: [...current.floorPlan.calibrationReferences, reference],
        scale: calculateScale([...current.floorPlan.calibrationReferences, reference]),
      };
      return { ...current, floorPlan };
    });
    setDrawingPoints([]);
    setActualLength("");
    setNotice(`${axis === "horizontal" ? "가로" : "세로"} 축척 기준을 추가했습니다. 다른 치수선도 계속 등록할 수 있습니다.`);
  };

  const deleteCalibrationReference = (id: string) => {
    setProject((current) => {
      const references = current.floorPlan.calibrationReferences.filter((reference) => reference.id !== id);
      const floorPlan = { ...current.floorPlan, calibrationReferences: references, scale: calculateScale(references) };
      return { ...current, floorPlan };
    });
  };

  const deleteMeasurement = (id: string) => {
    setProject((current) => ({
      ...current,
      floorPlan: { ...current.floorPlan, measurements: current.floorPlan.measurements.filter((measurement) => measurement.id !== id) },
    }));
  };

  const finishZone = () => {
    if (drawingPoints.length < 3) {
      setNotice("배치 영역은 모서리를 세 점 이상 선택해야 합니다.");
      return;
    }
    if (Math.abs(polygonArea(drawingPoints)) < 1) {
      setNotice("일직선이 아닌 실제 공간의 모서리를 선택해 주세요.");
      return;
    }
    if (!isSimplePolygon(drawingPoints)) {
      setNotice("영역의 선이 서로 교차합니다. 마지막 점을 취소하고 모서리를 순서대로 선택해 주세요.");
      return;
    }
    const name = zoneName.trim() || `배치 영역 ${project.floorPlan.zones.length + 1}`;
    setProject((current) => {
      const floorPlan = {
        ...current.floorPlan,
        zones: [...current.floorPlan.zones, { id: crypto.randomUUID(), name, points: drawingPoints }],
      };
      return { ...current, floorPlan };
    });
    setDrawingPoints([]);
    setZoneName("");
    setCanvasMode("idle");
    setNotice(`${name}을(를) 저장했습니다. 영역 밖의 가구는 위치를 유지하고 빨간색으로 표시됩니다.`);
  };

  const deleteZone = (id: string) => {
    setProject((current) => {
      const zones = current.floorPlan.zones.filter((zone) => zone.id !== id);
      const floorPlan = { ...current.floorPlan, zones };
      return { ...current, floorPlan };
    });
  };

  const renameZone = (id: string, currentName: string) => {
    const name = window.prompt("배치 영역 이름", currentName)?.trim();
    if (!name || name === currentName) return;
    if (name.length > 80) {
      setNotice("배치 영역 이름은 80자 이하로 입력해 주세요.");
      return;
    }
    setProject((current) => ({
      ...current,
      floorPlan: {
        ...current.floorPlan,
        zones: current.floorPlan.zones.map((zone) => zone.id === id ? { ...zone, name } : zone),
      },
    }));
  };

  const toggleCanvasMode = (mode: Exclude<CanvasMode, "idle">) => {
    setCanvasMode((current) => current === mode ? "idle" : mode);
    setDrawingPoints([]);
  };

  const addFurniture = (placement: Placement | null = null) => {
    const widthCm = Number(newFurniture.widthCm);
    const depthCm = Number(newFurniture.depthCm);
    if (!newFurniture.name.trim() || !Number.isFinite(widthCm) || widthCm <= 0 || !Number.isFinite(depthCm) || depthCm <= 0) {
      setNotice("가구 이름과 가로·세로 크기를 올바르게 입력해 주세요.");
      return;
    }
    const catalog = furnitureTypes.find((item) => item.value === newFurniture.type);
    const item: Furniture = {
      id: crypto.randomUUID(),
      type: newFurniture.type,
      name: newFurniture.name.trim(),
      widthCm,
      depthCm,
      color: catalog?.color ?? "#8e99aa",
      placement,
    };
    setProject((current) => ({ ...current, furniture: [...current.furniture, item] }));
    setSelectedId(item.id);
    setIsAdding(false);
    setNotice(null);
  };

  const addAtCanvasCenter = () => {
    if (!floorSize || !selectedFurniture || selectedFurniture.placement || !project.floorPlan.scale || canvasMode !== "idle") return;
    const placement: Placement = { x: floorSize.width / 2, y: floorSize.height / 2, rotation: 0 };
    const valid = canPlaceFurniture(selectedFurniture, placement, project, selectedFurniture.id);
    updateFurniture(selectedFurniture.id, (current) => ({ ...current, placement }));
    setNotice(valid ? null : "가구를 중앙에 놓았습니다. 배치 범위를 벗어나 빨간색으로 표시됩니다.");
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (project.floorPlan.imageFileName || project.furniture.length > 0) {
      const confirmed = window.confirm("새 도면을 올리면 현재 축척과 가구 배치가 초기화됩니다. 계속할까요?");
      if (!confirmed) return;
    }
    try {
      await readImageDimensions(file);
      const formData = new FormData();
      formData.append("file", file);
      const uploaded = await api<{ fileName: string; width: number; height: number }>("/api/floor-plan", { method: "POST", body: formData });
      setProject((current) => ({
        ...current,
        floorPlan: {
          imageFileName: uploaded.fileName,
          imageWidthPx: uploaded.width,
          imageHeightPx: uploaded.height,
          calibrationReferences: [],
          scale: null,
          measurements: [],
          zones: [],
        },
        furniture: [],
      }));
      setDrawingPoints([]);
      setCanvasMode("idle");
      setSelectedId(null);
      setImageVersion((version) => version + 1);
      setNotice("도면을 올렸습니다. 기준이 되는 길이의 두 점을 선택해 축척을 설정하세요.");
    } catch (error) {
      setNotice((error as Error).message);
    }
  };

  const rotateFurniture = (furniture: Furniture) => {
    if (!furniture.placement) return;
    const nextRotation = ((furniture.placement.rotation + 90) % 360) as Placement["rotation"];
    const nextPlacement = { ...furniture.placement, rotation: nextRotation };
    const valid = canPlaceFurniture(furniture, nextPlacement, project, furniture.id);
    updateFurniture(furniture.id, (current) => ({ ...current, placement: nextPlacement }));
    setNotice(valid ? null : "가구를 회전했습니다. 배치 범위를 벗어나거나 다른 가구와 겹쳐 빨간색으로 표시됩니다.");
  };

  const deleteFurniture = (id: string) => {
    setProject((current) => ({ ...current, furniture: current.furniture.filter((item) => item.id !== id) }));
    if (selectedId === id) setSelectedId(null);
  };

  const setDragPreview = (furniture: Furniture, placement: Placement) => {
    const valid = canPlaceFurniture(furniture, placement, project, furniture.id);
    setPreview({ id: furniture.id, placement, valid });
  };

  const handleDragStart = (furniture: Furniture, event: any) => {
    setSelectedId(furniture.id);
    setDraggingId(furniture.id);
    event.target?.to?.({ opacity: 0.8 });
  };

  const handleDragMove = (furniture: Furniture, event: any) => {
    const placement: Placement = {
      x: event.target.x(),
      y: event.target.y(),
      rotation: furniture.placement?.rotation ?? 0,
    };
    setDragPreview(furniture, placement);
  };

  const handleDragEnd = (furniture: Furniture, event: any) => {
    const candidate: Placement = {
      x: event.target.x(),
      y: event.target.y(),
      rotation: furniture.placement?.rotation ?? 0,
    };
    const valid = canPlaceFurniture(furniture, candidate, project, furniture.id);
    updateFurniture(furniture.id, (current) => ({ ...current, placement: candidate }));
    setNotice(valid ? null : "가구를 놓았습니다. 배치 범위를 벗어나거나 다른 가구와 겹쳐 빨간색으로 표시됩니다.");
    setPreview(null);
    setDraggingId(null);
  };

  const handleCanvasDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (canvasMode !== "idle") {
      setNotice("현재 도면 편집을 완료하거나 취소한 뒤 가구를 배치해 주세요.");
      return;
    }
    const id = event.dataTransfer.getData("text/furniture-id");
    const furniture = project.furniture.find((item) => item.id === id);
    if (!furniture || !project.floorPlan.scale) {
      setNotice("먼저 도면의 축척을 설정해 주세요.");
      return;
    }
    const point = canvasPoint(event.clientX, event.clientY);
    if (!point) return;
    const placement: Placement = { x: point.x, y: point.y, rotation: furniture.placement?.rotation ?? 0 };
    const valid = canPlaceFurniture(furniture, placement, project, furniture.id);
    updateFurniture(furniture.id, (current) => ({ ...current, placement }));
    setSelectedId(furniture.id);
    setNotice(valid ? null : "가구를 놓았습니다. 배치 범위를 벗어나거나 다른 가구와 겹쳐 빨간색으로 표시됩니다.");
  };

  const statusLabel: Record<SaveStatus, string> = { loading: "불러오는 중…", saving: "저장 중…", saved: "로컬 저장됨", error: "저장 확인 필요" };

  if (loadError) {
    return <main className="fatal-state"><div className="fatal-card"><span className="eyebrow">ROOM HELPER</span><h1>프로젝트를 불러오지 못했습니다.</h1><p>{loadError}</p><button className="primary-button" onClick={() => window.location.reload()}>다시 시도</button></div></main>;
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">⌂</span><div><strong>Room Helper</strong><span>쉽고 편하게 집꾸하자!</span></div></div>
        <div className="topbar-actions"><div className="topbar-status"><span className={`status-dot ${saveStatus}`} />{statusLabel[saveStatus]}</div><button className="help-button" aria-label="Room Helper 사용 방법 열기" aria-haspopup="dialog" aria-expanded={showHelp} onClick={() => setShowHelp(true)}>?</button></div>
      </header>

      <section className="workspace">
        <aside className="sidebar left-sidebar">
          <div className="panel-heading"><div><span className="eyebrow">01 · FLOOR PLAN</span><h2>도면 준비</h2></div></div>
          <label className="upload-zone">
            <input type="file" accept="image/png,image/jpeg,image/webp" onChange={handleFileUpload} />
            <span className="upload-icon">↥</span><strong>{project.floorPlan.imageFileName ? "도면 교체하기" : "집 도면 올리기"}</strong><small>PNG, JPG, WebP · 최대 12MB</small>
          </label>
          {floorSize && <div className="plan-meta"><span>원본 크기</span><strong>{floorSize.width.toLocaleString()} × {floorSize.height.toLocaleString()} px</strong></div>}

          <div className="section-divider" />
          <div className="panel-heading compact"><div><span className="eyebrow">02 · SCALE</span><h2>방 크기 맞추기</h2></div></div>
          <p className="helper-text">도면의 치수선 양 끝을 찍고 표시된 길이를 입력하세요. <br/>가로와 세로를 여러 개 등록할수록 정확해집니다.</p>
          <button className={`outline-button full mode-button ${canvasMode === "calibrate" ? "active" : ""}`} disabled={!floorSize} onClick={() => toggleCanvasMode("calibrate")}>
            {canvasMode === "calibrate" ? "기준선 선택 취소" : "축척 기준선 추가"}
          </button>
          {canvasMode === "calibrate" && <>
            <div className="calibration-tip">치수선의 첫 번째 끝점과 두 번째 끝점을 차례로 선택하세요. 방향은 자동 판별됩니다.</div>
            {drawingPoints.length > 0 && <div className="point-readout">{drawingPoints.length}/2 점 선택됨{drawingPoints.length === 2 && <span> · {distance(drawingPoints[0], drawingPoints[1]).toFixed(1)}px · {classifyCalibrationAxis(drawingPoints[0], drawingPoints[1]) === "horizontal" ? "가로" : "세로"}</span>}</div>}
            <label className="field-label">도면에 표시된 실제 길이
              <div className="input-with-unit"><input type="number" min="0.1" max="1000000" step="0.1" value={actualLength} onChange={(event) => setActualLength(event.target.value)} placeholder={calibrationUnit === "mm" ? "예: 6150" : "예: 615"} /><select aria-label="축척 길이 단위" value={calibrationUnit} onChange={(event) => setCalibrationUnit(event.target.value as "mm" | "cm" | "m")}><option value="mm">mm</option><option value="cm">cm</option><option value="m">m</option></select></div>
            </label>
            <button className="primary-button full scale-save" disabled={drawingPoints.length !== 2 || !actualLength} onClick={applyCalibration}>이 기준선 저장</button>
          </>}
          {project.floorPlan.scale && <div className="scale-summary">
            <div><span>가로 축척 {project.floorPlan.scale.xEstimated && <em>추정</em>}</span><strong>1cm = {project.floorPlan.scale.pixelsPerCmX.toFixed(3)}px</strong></div>
            <div><span>세로 축척 {project.floorPlan.scale.yEstimated && <em>추정</em>}</span><strong>1cm = {project.floorPlan.scale.pixelsPerCmY.toFixed(3)}px</strong></div>
          </div>}
          {project.floorPlan.calibrationReferences.length > 0 && <div className="mini-list">
            {project.floorPlan.calibrationReferences.map((reference, index) => <div key={reference.id}><span><i className={reference.axis} />{index + 1}. {reference.axis === "horizontal" ? "가로" : "세로"} {(reference.enteredLength ?? reference.actualLengthCm).toLocaleString()}{reference.enteredUnit ?? "cm"}</span><button aria-label="축척 기준선 삭제" onClick={() => deleteCalibrationReference(reference.id)}>×</button></div>)}
          </div>}
          <button className={`outline-button full mode-button ${canvasMode === "measure" ? "active" : ""}`} disabled={!project.floorPlan.scale} onClick={() => toggleCanvasMode("measure")}>
            {canvasMode === "measure" ? "측정 취소" : "길이 추가하기"}
          </button>
          {canvasMode === "measure" && <div className="calibration-tip">궁금한 구간의 양 끝을 선택하면 실제 길이를 계산해 저장합니다.</div>}
          {project.floorPlan.measurements.length > 0 && <div className="mini-list measurements">
            {project.floorPlan.measurements.map((measurement, index) => <div key={measurement.id}><span>{index + 1}. {project.floorPlan.scale ? measureRealDistance(measurement.start, measurement.end, project.floorPlan.scale).toFixed(1) : "-"}cm</span><button aria-label="측정선 삭제" onClick={() => deleteMeasurement(measurement.id)}>×</button></div>)}
          </div>}

          <div className="section-divider" />
          <div className="panel-heading compact"><div><span className="eyebrow">03 · FLOOR AREA</span><h2>배치 영역 그리기</h2></div></div>
          <p className="helper-text">방 안쪽 모서리를 차례로 찍어 벽 안의 공간을 만드세요. <br/> 벽으로 나뉜 방은 따로 그립니다.</p>
          <button className={`outline-button full mode-button ${canvasMode === "zone" ? "active" : ""}`} disabled={!floorSize} onClick={() => toggleCanvasMode("zone")}>
            {canvasMode === "zone" ? "영역 그리기 취소" : "새 배치 영역 그리기"}
          </button>
          {canvasMode === "zone" && <div className="zone-editor">
            <div className="calibration-tip">각 모서리를 순서대로 선택한 뒤 완료하세요. 현재 {drawingPoints.length}개 점</div>
            <label className="field-label">영역 이름<input maxLength={80} value={zoneName} onChange={(event) => setZoneName(event.target.value)} placeholder={`예: 침실 ${project.floorPlan.zones.length + 1}`} /></label>
            <button className="text-button undo-point" disabled={drawingPoints.length === 0} onClick={() => setDrawingPoints((points) => points.slice(0, -1))}>↶ 마지막 점 취소</button>
            <button className="primary-button full" disabled={drawingPoints.length < 3} onClick={finishZone}>영역 완성</button>
          </div>}
          {project.floorPlan.zones.length === 0 && floorSize && <div className="zone-warning">배치 영역이 없어 현재는 이미지 전체를 임시 바닥으로 사용합니다.</div>}
          {project.floorPlan.zones.length > 0 && <div className="mini-list zones">
            {project.floorPlan.zones.map((zone) => <div key={zone.id}><span>▱ {zone.name} · {zone.points.length}점</span><span className="mini-actions"><button aria-label={`${zone.name} 이름 변경`} onClick={() => renameZone(zone.id, zone.name)}>✎</button><button aria-label={`${zone.name} 삭제`} onClick={() => deleteZone(zone.id)}>×</button></span></div>)}
          </div>}

          <div className="section-divider" />
          <div className="panel-heading compact"><div><span className="eyebrow">04 · FURNITURE</span><h2>가구 준비</h2></div></div>
          <p className="helper-text">가구의 실제 가로·세로를 입력하면 오른쪽 목록에 추가됩니다.</p>
          <button className="primary-button full add-button" onClick={() => setIsAdding(true)}>＋ 가구 추가하기</button>

          <div className="sidebar-footer"><span>모든 정보는 이 컴퓨터의<br /><strong>data/project.json</strong>에 저장됩니다.</span></div>
        </aside>

        <section className="canvas-column">
          <div className="canvas-toolbar"><div><span className="eyebrow">LAYOUT BOARD</span><h1>{project.floorPlan.imageFileName ? "나의 공간" : "도면을 올려 시작하세요"}</h1></div><div className="zoom-controls"><button aria-label="축소" onClick={() => setZoom((value) => Math.max(0.5, Number((value - 0.1).toFixed(1))))}>−</button><span>{Math.round(zoom * 100)}%</span><button aria-label="확대" onClick={() => setZoom((value) => Math.min(2, Number((value + 0.1).toFixed(1))))}>＋</button></div></div>
          {notice && <div className="notice" role="status"><span>i</span>{notice}<button aria-label="알림 닫기" onClick={() => setNotice(null)}>×</button></div>}
          <div className={`canvas-wrap ${canvasMode !== "idle" ? "calibrating" : ""}`} ref={stageWrapRef} onDragOver={(event) => event.preventDefault()} onDrop={handleCanvasDrop}>
            {!floorSize ? <div className="empty-canvas"><div className="empty-grid" /><span className="empty-icon">⌂</span><h2>도면이 아직 없어요</h2><p>왼쪽에서 집 도면 이미지를 올리면<br />나만의 배치 보드가 열립니다.</p></div> : <Stage width={stageSize.width} height={stageSize.height} scaleX={1} scaleY={1} onClick={handleCanvasClick}>
              <Layer scaleX={viewScale} scaleY={viewScale}>
                {image && <KonvaImage image={image} width={floorSize.width} height={floorSize.height} listening={false} />}
                {!image && <Rect width={floorSize.width} height={floorSize.height} fill="#e9edf3" />}
                {project.floorPlan.zones.map((zone) => <Group key={zone.id} listening={false}>
                  <Line points={zone.points.flatMap((point) => [point.x, point.y])} closed fill="rgba(80, 155, 255, 0.14)" stroke="#5aa7ff" strokeWidth={2 / viewScale} dash={[7 / viewScale, 4 / viewScale]} />
                  <Text x={zone.points[0].x + 5 / viewScale} y={zone.points[0].y + 5 / viewScale} text={zone.name} fontSize={11 / viewScale} fill="#1c75d8" stroke="#fff" strokeWidth={2.5 / viewScale} />
                </Group>)}
                {project.floorPlan.calibrationReferences.map((reference) => {
                  const middle = { x: (reference.start.x + reference.end.x) / 2, y: (reference.start.y + reference.end.y) / 2 };
                  return <Group key={reference.id} listening={false}>
                    <Line points={[reference.start.x, reference.start.y, reference.end.x, reference.end.y]} stroke="#ff9f3f" strokeWidth={2.5 / viewScale} />
                    <Circle x={reference.start.x} y={reference.start.y} radius={4 / viewScale} fill="#ff9f3f" />
                    <Circle x={reference.end.x} y={reference.end.y} radius={4 / viewScale} fill="#ff9f3f" />
                    <Text x={middle.x - 45 / viewScale} y={middle.y - 17 / viewScale} width={90 / viewScale} align="center" text={`${(reference.enteredLength ?? reference.actualLengthCm).toLocaleString()}${reference.enteredUnit ?? "cm"}`} fontSize={11 / viewScale} fill="#d87014" stroke="#fff" strokeWidth={3 / viewScale} />
                  </Group>;
                })}
                {project.floorPlan.scale && project.floorPlan.measurements.map((measurement) => {
                  const middle = { x: (measurement.start.x + measurement.end.x) / 2, y: (measurement.start.y + measurement.end.y) / 2 };
                  return <Group key={measurement.id} listening={false}>
                    <Line points={[measurement.start.x, measurement.start.y, measurement.end.x, measurement.end.y]} stroke="#11a9bd" strokeWidth={2 / viewScale} dash={[5 / viewScale, 4 / viewScale]} />
                    <Text x={middle.x - 45 / viewScale} y={middle.y - 16 / viewScale} width={90 / viewScale} align="center" text={`${measureRealDistance(measurement.start, measurement.end, project.floorPlan.scale!).toFixed(1)}cm`} fontSize={11 / viewScale} fill="#087f91" stroke="#fff" strokeWidth={3 / viewScale} />
                  </Group>;
                })}
                {drawingPoints.length > 1 && <Line points={drawingPoints.flatMap((point) => [point.x, point.y])} closed={canvasMode === "zone" && drawingPoints.length >= 3} fill={canvasMode === "zone" ? "rgba(127, 145, 255, 0.18)" : undefined} stroke={canvasMode === "measure" ? "#11a9bd" : canvasMode === "zone" ? "#7f91ff" : "#ffb24b"} strokeWidth={3 / viewScale} dash={[8 / viewScale, 5 / viewScale]} listening={false} />}
                {drawingPoints.map((point, index) => <Circle key={`${point.x}-${point.y}-${index}`} x={point.x} y={point.y} radius={7 / viewScale} fill={canvasMode === "measure" ? "#11a9bd" : canvasMode === "zone" ? "#7f91ff" : "#ffb24b"} stroke="#fff" strokeWidth={2 / viewScale} listening={false} />)}
                {project.furniture.filter((item) => item.placement).map((furniture) => {
                  const placement = preview?.id === furniture.id ? preview.placement : furniture.placement!;
                  const footprint = footprintSize({ ...furniture, placement });
                  const width = footprint.widthCm * (project.floorPlan.scale?.pixelsPerCmX ?? 1);
                  const height = footprint.depthCm * (project.floorPlan.scale?.pixelsPerCmY ?? 1);
                  const isSelected = selectedId === furniture.id;
                  const isDragging = draggingId === furniture.id;
                  const valid = preview?.id === furniture.id
                    ? preview.valid
                    : canPlaceFurniture(furniture, furniture.placement!, project, furniture.id);
                  const color = valid ? "#46c78c" : "#ef6464";
                  return <Group key={furniture.id} x={placement.x} y={placement.y} listening={canvasMode === "idle"} draggable={Boolean(project.floorPlan.scale) && canvasMode === "idle"} onClick={(event) => { event.cancelBubble = true; setSelectedId(furniture.id); }} onDragStart={(event) => handleDragStart(furniture, event)} onDragMove={(event) => handleDragMove(furniture, event)} onDragEnd={(event) => handleDragEnd(furniture, event)}>
                    <Rect x={-width / 2} y={-height / 2} width={width} height={height} fill={color} opacity={isDragging ? 0.78 : 0.9} cornerRadius={5 / viewScale} stroke={isSelected ? "#fff" : color} strokeWidth={(isSelected ? 3 : 1) / viewScale} shadowColor="#101827" shadowBlur={isSelected ? 13 / viewScale : 4 / viewScale} shadowOpacity={0.2} />
                    <Text x={-width / 2 + 8 / viewScale} y={-6 / viewScale} width={width - 16 / viewScale} text={furniture.name} fontSize={Math.max(10, Math.min(16, 13 / viewScale))} fill="#fff" align="center" ellipsis verticalAlign="middle" />
                  </Group>;
                })}
              </Layer>
            </Stage>}
          </div>
          <div className="canvas-legend"><span><i className="legend-dot available" />정상 배치</span><span><i className="legend-dot unavailable" />범위 벗어남</span><span><i className="legend-dot floor-zone" />배치 영역</span><span className="canvas-hint">{canvasMode !== "idle" ? "도면 위에서 필요한 점을 선택하세요." : project.floorPlan.scale ? "가구는 어디든 놓을 수 있으며 범위를 벗어나면 빨간색으로 표시됩니다." : "가로·세로 축척 기준을 등록해 주세요."}</span></div>
        </section>

        <aside className="sidebar right-sidebar">
          <div className="panel-heading"><div><span className="eyebrow">04 · FURNITURE</span><h2>가구 목록 <em>{project.furniture.length}</em></h2></div><button className="icon-button" aria-label="가구 추가" onClick={() => setIsAdding(true)}>＋</button></div>
          <button className="primary-button full add-button" onClick={() => setIsAdding(true)}>＋ 가구 추가하기</button>
          {isAdding && <div className="furniture-form"><div className="form-title">새 가구</div><label className="field-label">종류<select value={newFurniture.type} onChange={(event) => { const type = event.target.value as FurnitureType; setNewFurniture((current) => ({ ...current, type, name: current.name === "침대" ? typeLabel(type) : current.name })); }}>{furnitureTypes.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label><label className="field-label">이름<input maxLength={80} value={newFurniture.name} onChange={(event) => setNewFurniture((current) => ({ ...current, name: event.target.value }))} placeholder="예: 퀸 침대" /></label><div className="form-row"><label className="field-label">가로 (cm)<input type="number" min="1" value={newFurniture.widthCm} onChange={(event) => setNewFurniture((current) => ({ ...current, widthCm: event.target.value }))} /></label><label className="field-label">세로 (cm)<input type="number" min="1" value={newFurniture.depthCm} onChange={(event) => setNewFurniture((current) => ({ ...current, depthCm: event.target.value }))} /></label></div><div className="form-actions"><button className="text-button" onClick={() => setIsAdding(false)}>취소</button><button className="primary-button" onClick={() => addFurniture()}>목록에 추가</button></div></div>}
          <div className="furniture-list">{project.furniture.length === 0 && !isAdding ? <div className="empty-list"><span>✦</span><p>아직 추가한 가구가 없어요.<br />가구를 추가해 배치를 시작해 보세요.</p></div> : project.furniture.map((furniture) => {
            const valid = furniture.placement
              ? canPlaceFurniture(furniture, furniture.placement, project, furniture.id)
              : null;
            return <div className={`furniture-card ${selectedId === furniture.id ? "selected" : ""}`} key={furniture.id} onClick={() => setSelectedId(furniture.id)} draggable onDragStart={(event) => { event.dataTransfer.setData("text/furniture-id", furniture.id); event.dataTransfer.effectAllowed = "move"; }}><span className="furniture-swatch" style={{ background: furniture.color }} /><div className="furniture-info"><strong>{furniture.name}</strong><small>{typeLabel(furniture.type)} · {furniture.widthCm} × {furniture.depthCm} cm</small><span className={`placement-state ${valid === false ? "invalid" : furniture.placement ? "placed" : "unplaced"}`}><i />{valid === false ? "배치 범위 벗어남" : furniture.placement ? "배치 가능" : "미배치 · 캔버스로 드래그"}</span></div><div className="card-actions">{furniture.placement && <button aria-label={`${furniture.name} 회전`} onClick={(event) => { event.stopPropagation(); rotateFurniture(furniture); }}>↻</button>}<button aria-label={`${furniture.name} 삭제`} onClick={(event) => { event.stopPropagation(); deleteFurniture(furniture.id); }}>×</button></div></div>;
          })}</div>
          {selectedFurniture && <div className="selected-actions"><div><span className="eyebrow">SELECTED</span><strong>{selectedFurniture.name}</strong></div>{!selectedFurniture.placement && <button className="outline-button" onClick={addAtCanvasCenter} disabled={!project.floorPlan.scale || canvasMode !== "idle"}>캔버스 중앙에 놓기</button>}</div>}
        </aside>
      </section>
      <footer className="app-footer">made by coticoger</footer>
      {showHelp && <div className="help-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowHelp(false); }}>
        <section className="help-modal" role="dialog" aria-modal="true" aria-labelledby="help-title">
          <div className="help-modal-header"><div><span className="eyebrow">QUICK GUIDE</span><h2 id="help-title">처음이라면 이렇게 사용하세요</h2></div><button className="modal-close" aria-label="사용 방법 닫기" onClick={() => setShowHelp(false)}>×</button></div>
          <div className="help-steps">
            <div className="help-step"><span>1</span><div><strong>도면 올리기</strong><p>왼쪽 `집 도면 올리기`에서 PNG, JPG, WebP 파일을 선택하세요.</p></div></div>
            <div className="help-step"><span>2</span><div><strong>축척 맞추기</strong><p>`축척 기준선 추가`를 누르고 도면에 표시된 치수선 양 끝을 클릭한 뒤 실제 숫자를 입력하세요. 건축 도면 숫자는 보통 mm이므로 기본 단위가 mm입니다.</p></div></div>
            <div className="help-step"><span>3</span><div><strong>가로·세로 기준을 더하기</strong><p>가로 치수와 세로 치수를 각각 하나 이상 등록하세요. 여러 기준선을 등록하면 클릭 오차가 평균화되고, 세로 축척이 추정 상태에서 정확한 값으로 바뀝니다.</p></div></div>
            <div className="help-step"><span>4</span><div><strong>방 영역 그리기</strong><p>`새 배치 영역 그리기`를 누르고 방 안쪽 모서리를 순서대로 클릭한 뒤 `영역 완성`을 누르세요. 벽으로 나뉜 방은 각각 그리고, 거실·주방처럼 이어진 공간은 하나로 그립니다.</p></div></div>
            <div className="help-step"><span>5</span><div><strong>가구 배치하기</strong><p>왼쪽 또는 오른쪽의 `가구 추가하기`에서 실제 가로·세로(cm)를 입력하세요. 오른쪽 가구 카드는 어느 위치든 놓을 수 있고, 배치 범위를 벗어나면 빨간색으로 표시됩니다.</p></div></div>
          </div>
          <div className="help-notes"><div><i className="legend-dot available" /><span>초록색: 영역 안에 놓을 수 있음</span></div><div><i className="legend-dot unavailable" /><span>빨간색: 벽 밖, 다른 방, 또는 다른 가구와 겹침</span></div><p><strong>↔ 도면의 다른 길이 재기</strong>로 축척이 맞는지 언제든 확인할 수 있습니다. 입력한 내용은 이 컴퓨터의 <code>data/project.json</code>에 자동 저장됩니다.</p></div>
          <button className="primary-button full" onClick={() => setShowHelp(false)}>확인했어요</button>
        </section>
      </div>}
    </main>
  );
}

export default App;
