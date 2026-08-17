import fssync from "node:fs";
import path from "node:path";
import { DOWNLOAD_DIR } from "../config/paths.js";
import { formatBytes } from "../utils/format.js";
import { assertArchiveLooksValid, extractArchive, isArchivePath } from "./archive.service.js";
import { relativeFromRoot, safeName, uniquePath } from "./file.service.js";
import { updateJob } from "./job.service.js";

const CHUNK_SIZE = 1024 * 1024;

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

export async function downloadArchive(job, url) {
  updateJob(job, { status: "running", percent: 2, message: "Conectando con la URL" });
  const response = await fetch(url, { headers: { "User-Agent": "rar-smb-web/1.0" } });
  if (!response.ok || !response.body) {
    throw new Error(`No se pudo descargar. HTTP ${response.status}`);
  }

  const filename = filenameFromHeaders(url, response);
  const destination = await uniquePath(DOWNLOAD_DIR, filename);
  const total = Number(response.headers.get("content-length") || 0);
  const contentEncoding = response.headers.get("content-encoding");
  const canVerifyLength = total > 0 && (!contentEncoding || contentEncoding.toLowerCase() === "identity");
  let downloaded = 0;

  updateJob(job, { percent: 5, message: `Descargando ${path.basename(destination)}` });
  const output = fssync.createWriteStream(destination);
  const reader = response.body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await writeChunk(output, Buffer.from(value));
      downloaded += value.byteLength;
      if (total > 0) {
        const percent = Math.max(5, Math.min(70, Math.round((downloaded / total) * 65) + 5));
        updateJob(job, { percent, message: `Descargando ${formatBytes(downloaded)} de ${formatBytes(total)}` });
      } else if (downloaded % (CHUNK_SIZE * 5) < CHUNK_SIZE) {
        updateJob(job, { message: `Descargado ${formatBytes(downloaded)}` });
      }
    }
  } finally {
    await new Promise((resolve, reject) => {
      output.end(resolve);
      output.on("error", reject);
    });
  }

  if (canVerifyLength && downloaded !== total) {
    throw new Error(`La descarga quedo incompleta: ${formatBytes(downloaded)} de ${formatBytes(total)}.`);
  }
  return destination;
}

export async function processDownload(job, url, archivePassword) {
  try {
    const archivePath = await downloadArchive(job, url);
    if (!isArchivePath(archivePath)) {
      updateJob(job, {
        status: "done",
        percent: 100,
        message: "Descarga completada",
        result: { file: relativeFromRoot(archivePath) }
      });
      return;
    }
    if (!archivePassword) {
      throw new Error("La contrasena es obligatoria para extraer archivos comprimidos.");
    }
    await assertArchiveLooksValid(archivePath);
    const { extractDir, extracted } = await extractArchive(job, archivePath, archivePassword);
    updateJob(job, {
      status: "done",
      percent: 100,
      message: "Descarga y descompresion completadas",
      result: {
        archive: relativeFromRoot(archivePath),
        extractDir: relativeFromRoot(extractDir),
        extracted
      }
    });
  } catch (error) {
    updateJob(job, { status: "error", error: error.message, message: "Proceso fallido" });
  }
}
