import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import multer from "multer";
import { imageSize } from "image-size";
import { calculateScale, defaultProject, migrateProject, projectSchema, type Project } from "@roomhelper/shared";

const port = Number(process.env.PORT ?? 8787);
const dataDir = path.resolve(process.env.ROOMHELPER_DATA_DIR ?? path.join(process.cwd(), "data"));
const uploadsDir = path.join(dataDir, "uploads");
const projectPath = path.join(dataDir, "project.json");
const clientDist = path.resolve(process.env.ROOMHELPER_CLIENT_DIST ?? path.join(process.cwd(), "client", "dist"));
const maxUploadBytes = 12 * 1024 * 1024;

const allowedMimeTypes = new Set(["image/png", "image/jpeg", "image/webp"]);

function apiError(code: string, message: string, status = 400): Error & { status: number; code: string } {
  const error = new Error(message) as Error & { status: number; code: string };
  error.status = status;
  error.code = code;
  return error;
}

async function ensureDataDirectory() {
  await fs.mkdir(uploadsDir, { recursive: true });
  try {
    await fs.access(projectPath);
  } catch {
    await writeProject(defaultProject());
  }
}

async function readProject(): Promise<Project> {
  let raw: string;
  try {
    raw = await fs.readFile(projectPath, "utf8");
  } catch (error) {
    throw apiError("PROJECT_READ_FAILED", `프로젝트 파일을 읽을 수 없습니다: ${(error as Error).message}`, 500);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const backupPath = `${projectPath}.corrupt-${Date.now()}`;
    await fs.rename(projectPath, backupPath).catch(() => undefined);
    throw apiError("PROJECT_CORRUPT", "프로젝트 JSON이 손상되었습니다. 백업 파일을 확인하고 새 프로젝트를 시작해 주세요.", 500);
  }

  try {
    const project = migrateProject(parsed);
    if ((parsed as { schemaVersion?: number }).schemaVersion !== project.schemaVersion) {
      await fs.copyFile(projectPath, `${projectPath}.v1-backup`, fsConstants.COPYFILE_EXCL).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      await writeProject(project);
    }
    return project;
  } catch {
    throw apiError("PROJECT_INVALID", "프로젝트 JSON 구조가 올바르지 않습니다.", 500);
  }
}

async function writeProject(project: Project) {
  const result = projectSchema.safeParse(project);
  if (!result.success) throw apiError("PROJECT_INVALID", "저장할 프로젝트 데이터가 올바르지 않습니다.");
  const temporaryPath = `${projectPath}.tmp-${process.pid}-${randomUUID()}`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(result.data, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, projectPath);
}

function hasValidImageSignature(buffer: Buffer, mimeType: string) {
  if (mimeType === "image/png") {
    return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (mimeType === "image/jpeg") {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  return buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxUploadBytes, files: 1 },
});

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/api/project", async (_request, response, next) => {
  try {
    response.json(await readProject());
  } catch (error) {
    next(error);
  }
});

app.put("/api/project", async (request, response, next) => {
  try {
    const parsed = projectSchema.safeParse(request.body);
    if (!parsed.success) throw apiError("PROJECT_INVALID", "프로젝트 데이터가 올바르지 않습니다.");
    const project = {
      ...parsed.data,
      updatedAt: new Date().toISOString(),
      floorPlan: {
        ...parsed.data.floorPlan,
        scale: calculateScale(parsed.data.floorPlan.calibrationReferences),
      },
    } satisfies Project;
    await writeProject(project);
    response.json(project);
  } catch (error) {
    next(error);
  }
});

app.post("/api/floor-plan", upload.single("file"), async (request, response, next) => {
  try {
    const file = request.file;
    if (!file) throw apiError("FILE_REQUIRED", "평면도 이미지 파일을 선택해 주세요.");
    if (!allowedMimeTypes.has(file.mimetype)) throw apiError("FILE_TYPE_UNSUPPORTED", "PNG, JPEG, WebP 이미지만 업로드할 수 있습니다.");
    if (!hasValidImageSignature(file.buffer, file.mimetype)) throw apiError("FILE_INVALID", "이미지 파일을 읽을 수 없습니다.");

    let dimensions: { width: number; height: number };
    try {
      const result = imageSize(file.buffer);
      if (!result.width || !result.height) throw new Error("missing dimensions");
      dimensions = { width: result.width, height: result.height };
    } catch {
      throw apiError("FILE_INVALID", "이미지의 크기를 확인할 수 없습니다.");
    }

    const extension = file.mimetype === "image/png" ? "png" : file.mimetype === "image/webp" ? "webp" : "jpg";
    const fileName = `${randomUUID()}.${extension}`;
    await fs.writeFile(path.join(uploadsDir, fileName), file.buffer);
    response.json({ fileName, width: dimensions.width, height: dimensions.height });
  } catch (error) {
    next(error);
  }
});

app.get("/api/floor-plan/:fileName", async (request, response, next) => {
  try {
    const { fileName } = request.params;
    if (!/^[a-zA-Z0-9._-]+$/.test(fileName) || fileName.includes("..")) throw apiError("FILE_NOT_FOUND", "평면도 파일을 찾을 수 없습니다.", 404);
    const filePath = path.resolve(uploadsDir, fileName);
    if (!filePath.startsWith(`${uploadsDir}${path.sep}`)) throw apiError("FILE_NOT_FOUND", "평면도 파일을 찾을 수 없습니다.", 404);
    response.sendFile(filePath, (error) => {
      if (error && !response.headersSent) next(apiError("FILE_NOT_FOUND", "평면도 파일을 찾을 수 없습니다.", 404));
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/health", (_request, response) => response.json({ ok: true }));

// A production build can be opened from the API port as well. In development Vite
// serves the client and proxies /api, so this middleware is simply bypassed there.
app.use(express.static(clientDist));
app.get("*", (request, response, next) => {
  if (request.path.startsWith("/api/")) {
    next(apiError("NOT_FOUND", "요청한 경로를 찾을 수 없습니다.", 404));
    return;
  }
  response.sendFile(path.join(clientDist, "index.html"), (error) => {
    if (error && !response.headersSent) next(apiError("CLIENT_NOT_BUILT", "클라이언트 빌드 파일을 찾을 수 없습니다. npm run build를 먼저 실행해 주세요.", 404));
  });
});

const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  const status = typeof error?.status === "number" ? error.status : error?.code === "LIMIT_FILE_SIZE" ? 413 : 500;
  const code = error?.code === "LIMIT_FILE_SIZE" ? "FILE_TOO_LARGE" : error?.code ?? "INTERNAL_ERROR";
  const message = error?.code === "LIMIT_FILE_SIZE" ? "이미지 파일은 12MB 이하만 업로드할 수 있습니다." : error?.message ?? "알 수 없는 오류가 발생했습니다.";
  response.status(status).json({ code, message });
};

app.use(errorHandler);

ensureDataDirectory()
  .then(() => {
    app.listen(port, "127.0.0.1", () => {
      console.log(`Room Helper API listening on http://127.0.0.1:${port}`);
    });
  })
  .catch((error) => {
    console.error("Unable to initialize data directory", error);
    process.exitCode = 1;
  });

export { app, readProject, writeProject };
