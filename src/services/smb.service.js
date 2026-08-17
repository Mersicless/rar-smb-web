import path from "node:path";
import { runCommand } from "../utils/command.js";
import { formatBytes } from "../utils/format.js";
import { requireText } from "../utils/validation.js";
import { collectFiles } from "./file.service.js";
import { updateJob } from "./job.service.js";

export function parseSmbTarget(input) {
  const route = requireText(input.route, "La ruta SMB");
  const normalized = route.replaceAll("\\", "/").replace(/^smb:/i, "");
  const match = normalized.match(/^\/\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
  if (!match) {
    const error = new Error("La ruta SMB debe tener formato //servidor/recurso/carpeta.");
    error.statusCode = 400;
    throw error;
  }
  return { host: match[1], share: match[2], remoteDir: (match[3] || "").replace(/^\/+|\/+$/g, "") };
}

function smbQuote(value) {
  const text = String(value);
  if (/[";\r\n]/.test(text)) throw new Error(`Nombre no compatible con SMB: ${text}`);
  return `"${text}"`;
}

function remoteDirsFor(files, rootRemoteDir) {
  const dirs = new Set();
  for (const file of files) {
    const dir = path.posix.dirname(path.posix.join(rootRemoteDir, file.remoteRelative));
    if (!dir || dir === ".") continue;
    const parts = dir.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      dirs.add(current);
    }
  }
  return [...dirs].sort((a, b) => a.localeCompare(b));
}

export async function runSmb(job, target, credentials, files) {
  const service = `//${target.host}/${target.share}`;
  const user = credentials.domain ? `${credentials.domain}\\${credentials.username}` : credentials.username;
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0) || files.length || 1;
  let transferredBytes = 0;

  updateJob(job, { status: "running", percent: 1, message: "Creando carpetas remotas" });
  const dirs = remoteDirsFor(files, target.remoteDir);
  if (dirs.length) {
    const mkdirCommands = dirs.map((dir) => `mkdir ${smbQuote(dir)}`).join("; ");
    await runCommand("smbclient", [service, "-U", user, "-c", mkdirCommands], {
      input: `${credentials.password}\n`
    }).catch((error) => {
      if (!/NT_STATUS_OBJECT_NAME_COLLISION|ERRDOS - ERRfilexists/i.test(error.message)) throw error;
    });
  }

  for (const file of files) {
    const remotePath = path.posix.join(target.remoteDir, file.remoteRelative);
    updateJob(job, { message: `Transfiriendo ${file.remoteRelative}` });
    await runCommand("smbclient", [
      service, "-U", user, "-c", `put ${smbQuote(file.absolute)} ${smbQuote(remotePath)}`
    ], { input: `${credentials.password}\n` });
    transferredBytes += file.size || 1;
    const percent = Math.min(100, Math.round((transferredBytes / totalBytes) * 100));
    updateJob(job, { percent, message: `Transferido ${formatBytes(transferredBytes)} de ${formatBytes(totalBytes)}` });
  }
}

export async function prepareSmbTransfer({ paths, route, username, password, domain }) {
  if (!Array.isArray(paths) || paths.length === 0) {
    const error = new Error("Selecciona al menos un archivo para transferir.");
    error.statusCode = 400;
    throw error;
  }
  const target = parseSmbTarget({ route });
  const credentials = {
    username: requireText(username, "El usuario SMB"),
    password: requireText(password, "La contrasena SMB"),
    domain: typeof domain === "string" ? domain.trim() : ""
  };
  const files = await collectFiles(paths);
  if (!files.length) {
    const error = new Error("No hay archivos dentro de la seleccion.");
    error.statusCode = 400;
    throw error;
  }
  return { target, credentials, files };
}

export async function processSmbTransfer(job, target, credentials, files) {
  try {
    await runSmb(job, target, credentials, files);
    updateJob(job, {
      status: "done",
      percent: 100,
      message: "Transferencia SMB completada",
      result: {
        transferred: files.length,
        target: `//${target.host}/${target.share}/${target.remoteDir}`.replace(/\/$/, "")
      }
    });
  } catch (error) {
    updateJob(job, { status: "error", error: error.message, message: "Transferencia fallida" });
  }
}
