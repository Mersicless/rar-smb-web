import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { DOWNLOAD_DIR } from "../config/paths.js";
import { formatBytes } from "../utils/format.js";
import { assertArchiveLooksValid, extractArchive, isArchivePath } from "./archive.service.js";
import { relativeFromRoot, safeName, uniquePath } from "./file.service.js";
import { updateJob } from "./job.service.js";

const CHUNK_SIZE = 1024 * 1024;
const MAX_CONCURRENT_DOWNLOADS = 3;

const downloadQueue = [];
let activeDownloads = 0;

function filenameFromHeaders(url, response) {
  const disposition = response.headers.get("content-disposition") || "";
  const match = disposition.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
  if (match) return safeName(match[1]);
  const parsed = new URL(response.url || url);
  return safeName(path.basename(parsed.pathname), "archivo.rar");
}

function writeChunk(stream, chunk) {
  return new Promise((resolve, reject) => {
    if (stream.write(chunk)) {
      resolve();
      return;
    }
    stream.once("drain", resolve);
    stream.once("error", reject);
  });
}

function isAbortError(error) {
  return error?.name === "AbortError" || /aborted|abort/i.test(String(error?.message || ""));
}

async function removePartial(job) {
  const partial = job.partialPath;
  if (!partial) return;
  try {
    await fs.unlink(partial);
  } catch {
    // El parcial puede no existir si la descarga no llegó a crear el archivo.
  }
  job.partialPath = null;
}

export async function downloadArchive(job, url) {
  const controller = new AbortController();
  job.abortController = controller;
  updateJob(job, { status: "running", percent: 2, message: "Conectando con la URL" });
  const response = await fetch(url, {
    headers: { "User-Agent": "rar-smb-web/1.0" },
    signal: controller.signal
  });
  if (!response.ok || !response.body) {
    throw new Error(`No se pudo descargar. HTTP ${response.status}`);
  }

  const filename = filenameFromHeaders(url, response);
  const destination = await uniquePath(DOWNLOAD_DIR, filename);
  job.partialPath = destination;
  job.filename = path.basename(destination);
  const total = Number(response.headers.get("content-length") || 0);
  const contentEncoding = response.headers.get("content-encoding");
  const canVerifyLength = total > 0 && (!contentEncoding || contentEncoding.toLowerCase() === "identity");
  let downloaded = 0;
  const startedAt = Date.now();

  updateJob(job, {
    percent: 5,
    filename: job.filename,
    totalBytes: total,
    bytesDownloaded: 0,
    message: `Descargando ${job.filename}`
  });
  const output = fssync.createWriteStream(destination, { flags: "wx" });
  const reader = response.body.getReader();

  try {
    while (true) {
      if (controller.signal.aborted) {
        const abortErr = new Error("La descarga fue cancelada.");
        abortErr.name = "AbortError";
        throw abortErr;
      }
      const { done, value } = await reader.read();
      if (done) break;
      await writeChunk(output, Buffer.from(value));
      downloaded += value.byteLength;
      const elapsedSec = Math.max(0.001, (Date.now() - startedAt) / 1000);
      const speedBps = downloaded / elapsedSec;
      const etaSeconds = total > downloaded && speedBps > 0
        ? Math.round((total - downloaded) / speedBps)
        : null;
      if (total > 0) {
        const percent = Math.max(5, Math.min(70, Math.round((downloaded / total) * 65) + 5));
        updateJob(job, {
          percent,
          filename: job.filename,
          bytesDownloaded: downloaded,
          totalBytes: total,
          speedBps,
          etaSeconds,
          message: `Descargando ${formatBytes(downloaded)} de ${formatBytes(total)}`
        });
      } else if (downloaded % (CHUNK_SIZE * 5) < CHUNK_SIZE) {
        updateJob(job, {
          filename: job.filename,
          bytesDownloaded: downloaded,
          totalBytes: 0,
          speedBps,
          etaSeconds: null,
          message: `Descargado ${formatBytes(downloaded)}`
        });
      }
    }
  } catch (error) {
    try {
      output.destroy();
    } catch {
      // ignore
    }
    if (isAbortError(error) || job.status === "cancelled") {
      await removePartial(job);
      const cancelled = new Error("Descarga cancelada");
      cancelled.cancelled = true;
      throw cancelled;
    }
    await removePartial(job);
    throw error;
  } finally {
    await new Promise((resolve) => {
      if (output.closed || output.destroyed) {
        resolve();
        return;
      }
      output.end(() => resolve());
      output.on("error", () => resolve());
    });
  }

  if (controller.signal.aborted || job.status === "cancelled") {
    await removePartial(job);
    const cancelled = new Error("Descarga cancelada");
    cancelled.cancelled = true;
    throw cancelled;
  }

  if (canVerifyLength && downloaded !== total) {
    await removePartial(job);
    throw new Error(`La descarga quedó incompleta: ${formatBytes(downloaded)} de ${formatBytes(total)}.`);
  }
  job.partialPath = null;
  job.abortController = null;
  // Desde aquí (descompresión) ya no se cancela: antes Cancelar respondía "cancelada"
  // pero unrar seguía, terminaba en "completada" y hasta borraba el .rar.
  updateJob(job, { cancellable: false });
  return destination;
}

export async function processDownload(job, url, archivePassword, deleteArchiveAfterExtract = false) {
  try {
    const archivePath = await downloadArchive(job, url);
    if (!isArchivePath(archivePath)) {
      updateJob(job, {
        status: "done",
        percent: 100,
        filename: path.basename(archivePath),
        message: "Descarga completada",
        result: { file: relativeFromRoot(archivePath) }
      });
      return;
    }
    if (!archivePassword) {
      throw new Error("La contraseña es obligatoria para extraer archivos comprimidos.");
    }
    await assertArchiveLooksValid(archivePath);
    const { extractDir, extracted } = await extractArchive(job, archivePath, archivePassword);
    const archiveName = path.basename(archivePath);
    if (deleteArchiveAfterExtract) {
      try {
        await fs.unlink(archivePath);
      } catch (error) {
        updateJob(job, {
          status: "done",
          percent: 100,
          message: `Descarga y descompresión completadas (no se pudo borrar ${archiveName})`,
          result: {
            archive: relativeFromRoot(archivePath),
            extractDir: relativeFromRoot(extractDir),
            extracted,
            archiveDeleted: false
          }
        });
        return;
      }
    }
    updateJob(job, {
      status: "done",
      percent: 100,
      message: deleteArchiveAfterExtract
        ? `Descarga y descompresión completadas (${archiveName} borrado)`
        : "Descarga y descompresión completadas",
      result: {
        archive: deleteArchiveAfterExtract ? null : relativeFromRoot(archivePath),
        extractDir: relativeFromRoot(extractDir),
        extracted,
        archiveDeleted: Boolean(deleteArchiveAfterExtract)
      }
    });
  } catch (error) {
    if (error.cancelled || job.status === "cancelled") {
      updateJob(job, {
        status: "cancelled",
        error: null,
        message: "Descarga cancelada",
        percent: job.percent || 0
      });
      return;
    }
    updateJob(job, { status: "error", error: error.message, message: "Proceso fallido" });
  }
}

function pumpDownloadQueue() {
  while (activeDownloads < MAX_CONCURRENT_DOWNLOADS && downloadQueue.length) {
    const next = downloadQueue.shift();
    if (!next || next.job.status === "cancelled") continue;
    activeDownloads += 1;
    updateJob(next.job, { message: "Iniciando descarga" });
    Promise.resolve()
      .then(() => processDownload(
        next.job,
        next.url,
        next.archivePassword,
        next.deleteArchiveAfterExtract
      ))
      .finally(() => {
        activeDownloads -= 1;
        pumpDownloadQueue();
      });
  }
}

export function enqueueDownload(job, url, archivePassword, deleteArchiveAfterExtract = false) {
  downloadQueue.push({ job, url, archivePassword, deleteArchiveAfterExtract });
  const position = downloadQueue.length + activeDownloads;
  if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) {
    updateJob(job, {
      status: "queued",
      message: `En cola (posición ${downloadQueue.length})`
    });
  }
  pumpDownloadQueue();
  return position;
}

export async function cancelDownloadJob(job) {
  if (!job || job.type !== "download") {
    const error = new Error("Solo se pueden cancelar descargas.");
    error.statusCode = 400;
    throw error;
  }
  if (job.status === "done" || job.status === "error" || job.status === "cancelled") {
    const error = new Error("Ese trabajo ya terminó.");
    error.statusCode = 409;
    throw error;
  }

  if (!job.cancellable) {
    const error = new Error("La descarga ya terminó y se está descomprimiendo; eso no se puede cancelar.");
    error.statusCode = 409;
    throw error;
  }

  const queuedIndex = downloadQueue.findIndex((item) => item.job.id === job.id);
  if (queuedIndex >= 0) {
    downloadQueue.splice(queuedIndex, 1);
    updateJob(job, { status: "cancelled", message: "Descarga cancelada", error: null });
    return publicCancelResult(job);
  }

  job.status = "cancelled";
  if (job.abortController) {
    try {
      job.abortController.abort();
    } catch {
      // ignore
    }
  }
  await removePartial(job);
  updateJob(job, { status: "cancelled", message: "Descarga cancelada", error: null });
  return publicCancelResult(job);
}

function publicCancelResult(job) {
  return {
    id: job.id,
    status: job.status,
    message: job.message
  };
}
