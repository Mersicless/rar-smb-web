import fs from "node:fs/promises";
import path from "node:path";
import { DOWNLOAD_DIR } from "../config/paths.js";
import { commandExists, firstAvailableCommand, runCommand } from "../utils/command.js";
import { listTree, uniquePath } from "./file.service.js";
import { updateJob } from "./job.service.js";

const ARCHIVE_EXTENSIONS = new Set([
  ".7z", ".bz2", ".gz", ".lzma", ".rar", ".tar", ".tbz", ".tbz2",
  ".tgz", ".txz", ".xz", ".zip"
]);

export function isArchivePath(filePath) {
  return ARCHIVE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function startsWithBytes(buffer, bytes) {
  return bytes.every((byte, index) => buffer[index] === byte);
}

function printablePrefix(buffer) {
  return buffer.toString("utf8").replace(/[^\x20-\x7E]+/g, " ").trim().slice(0, 90);
}

export async function assertArchiveLooksValid(archivePath) {
  const extension = path.extname(archivePath).toLowerCase();
  const handle = await fs.open(archivePath, "r");
  const buffer = Buffer.alloc(128);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
  await handle.close();
  const prefix = buffer.subarray(0, bytesRead);
  const checks = {
    ".7z": (value) => startsWithBytes(value, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]),
    ".rar": (value) => (
      startsWithBytes(value, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]) ||
      startsWithBytes(value, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00])
    ),
    ".zip": (value) => startsWithBytes(value, [0x50, 0x4b])
  };
  const check = checks[extension];
  if (!check || check(prefix)) return;
  const preview = printablePrefix(prefix);
  const extra = preview ? ` Primeros bytes: "${preview}"` : "";
  throw new Error(`El archivo descargado se llama ${extension}, pero no tiene firma de archivo comprimido valida.${extra}`);
}

export async function extractArchive(job, archivePath, archivePassword) {
  const extractDir = await uniquePath(DOWNLOAD_DIR, `${path.parse(archivePath).name}_extraido`);
  await fs.mkdir(extractDir, { recursive: true });
  updateJob(job, { percent: 75, message: "Descomprimiendo archivo comprimido" });

  const unrar = firstAvailableCommand(["unrar", "unrar-nonfree"]);
  if (path.extname(archivePath).toLowerCase() === ".rar" && unrar) {
    await runUnrar(unrar, archivePath, extractDir, archivePassword);
    updateJob(job, { percent: 90, message: "Leyendo contenido extraido" });
    return { extractDir, extracted: await listTree(extractDir) };
  }

  const sevenZip = firstAvailableCommand(["7zz", "7z"]);
  if (sevenZip) {
    try {
      await runCommand(sevenZip, ["x", "-y", `-p${archivePassword}`, `-o${extractDir}`, archivePath]);
    } catch (error) {
      if (!commandExists("unar")) throw error;
      updateJob(job, { message: "7-Zip fallo; probando extractor alterno" });
      await runUnarFallback(archivePath, extractDir, archivePassword, error);
    }
  } else if (commandExists("unar")) {
    await runUnarFallback(archivePath, extractDir, archivePassword);
  } else {
    throw new Error("No hay extractor instalado. Instala unrar, 7zip o unar.");
  }

  updateJob(job, { percent: 90, message: "Leyendo contenido extraido" });
  return { extractDir, extracted: await listTree(extractDir) };
}

async function runUnrar(command, archivePath, extractDir, archivePassword) {
  await runCommand(command, ["x", "-idq", "-o+", `-p${archivePassword}`, archivePath, `${extractDir}${path.sep}`]);
}

async function runUnarFallback(archivePath, extractDir, archivePassword, previousError = null) {
  try {
    await runCommand("unar", ["-quiet", "-password", archivePassword, "-output-directory", extractDir, archivePath]);
  } catch (error) {
    if (!previousError) throw error;
    throw new Error(`7-Zip no pudo extraer el archivo: ${previousError.message}\nunar tampoco pudo extraerlo: ${error.message}`);
  }
}

