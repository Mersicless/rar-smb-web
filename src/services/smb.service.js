import fs from "node:fs/promises";
import path from "node:path";
import { runCommand } from "../utils/command.js";
import { formatBytes } from "../utils/format.js";
import { requireText } from "../utils/validation.js";
import { collectFiles } from "./file.service.js";
import { updateJob } from "./job.service.js";

const SMB_ERROR_MESSAGES = [
  {
    match: /NT_STATUS_LOGON_FAILURE|NT_STATUS_WRONG_PASSWORD|NT_STATUS_PASSWORD_MUST_CHANGE|Session setup failed/i,
    message: "Usuario o contraseña incorrectos"
  },
  {
    match: /NT_STATUS_ACCESS_DENIED/i,
    message: "Acceso denegado en El Castillo"
  },
  {
    match: /NT_STATUS_BAD_NETWORK_NAME|NT_STATUS_OBJECT_PATH_NOT_FOUND|NT_STATUS_OBJECT_NAME_NOT_FOUND|NT_STATUS_NO_SUCH_FILE/i,
    message: "La ruta no existe en El Castillo"
  },
  {
    match: /NT_STATUS_DISK_FULL|NT_STATUS_INSUFFICIENT_RESOURCES/i,
    message: "No hay espacio en El Castillo"
  },
  {
    // "do_connect: Connection to X failed (Error NT_STATUS_IO_TIMEOUT|UNSUCCESSFUL...)":
    // nunca hubo conexión (IP que no responde, nombre que no existe). Va antes que
    // "Se perdió la conexión", que también reconoce IO_TIMEOUT.
    match: /Connection to \S+ failed/i,
    message: "No se pudo conectar con El Castillo (revisa la IP o el nombre del servidor)"
  },
  {
    match: /NT_STATUS_NETWORK_NAME_DELETED|NT_STATUS_CONNECTION_DISCONNECTED|NT_STATUS_CONNECTION_RESET|NT_STATUS_IO_TIMEOUT/i,
    message: "Se perdió la conexión con El Castillo"
  },
  {
    match: /NT_STATUS_HOST_UNREACHABLE|NT_STATUS_BAD_NETWORK_PATH|NT_STATUS_NETWORK_UNREACHABLE|NT_STATUS_CONNECTION_REFUSED/i,
    message: "No se pudo conectar con El Castillo"
  },
  {
    match: /NT_STATUS_SHARING_VIOLATION|NT_STATUS_FILE_IS_A_DIRECTORY|NT_STATUS_NOT_A_DIRECTORY/i,
    message: "No se pudo escribir el archivo en El Castillo"
  },
  {
    match: /NT_STATUS_OBJECT_NAME_COLLISION/i,
    message: "Ya existe un archivo con ese nombre en El Castillo"
  }
];

export function translateSmbError(raw) {
  const text = String(raw || "").trim();
  if (!text) return "Error de SMB desconocido";
  for (const entry of SMB_ERROR_MESSAGES) {
    if (entry.match.test(text)) {
      const code = text.match(/NT_STATUS_\w+/i)?.[0];
      return code ? `${entry.message} (${code})` : entry.message;
    }
  }
  const code = text.match(/NT_STATUS_\w+/i)?.[0];
  if (code) return `Error de SMB: ${code}`;
  return text.length > 220 ? `${text.slice(0, 217)}...` : text;
}

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

function remoteDirsFor(files, dirs, rootRemoteDir) {
  const all = new Set();
  const add = (dir) => {
    if (!dir || dir === ".") return;
    let current = "";
    for (const part of dir.split("/").filter(Boolean)) {
      current = current ? `${current}/${part}` : part;
      all.add(current);
    }
  };
  for (const file of files) add(path.posix.dirname(path.posix.join(rootRemoteDir, file.remoteRelative)));
  // Las carpetas vacías también se crean en el destino.
  for (const dir of dirs) add(path.posix.join(rootRemoteDir, dir));
  return [...all].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
}

// smbclient sigue con el siguiente comando aunque uno falle y su código de salida
// es solo el del último comando, así que se revisa la salida en busca de NT_STATUS.
// Antes se quitan los nombres de nuestros archivos y carpetas: un nombre puede
// contener "NT_STATUS_" sin que haya error. No se descartan líneas enteras, porque
// smbclient escribe "putting file X as Y " sin salto de línea y, si falla el
// cierre, el NT_STATUS de error sale en esa misma línea.
function withoutNames(output, names) {
  let clean = output;
  for (const name of names) {
    for (const variant of new Set([name, name.replaceAll("/", "\\")])) {
      if (variant) clean = clean.split(variant).join("<nombre>");
    }
  }
  return clean;
}

function smbErrors(output, { ignoreCollision = false, names = [] } = {}) {
  // Los nombres no tienen saltos de línea (smbQuote los rechaza), así que las
  // líneas limpias y las originales coinciden una a una; se devuelve la original.
  const original = output.split(/\r?\n/);
  return withoutNames(output, names).split(/\r?\n/)
    .map((line, index) => ({ line, original: original[index] }))
    .filter(({ line }) => /NT_STATUS_\w+/.test(line))
    .filter(({ line }) => !(ignoreCollision && /NT_STATUS_OBJECT_NAME_COLLISION/.test(line)))
    .map(({ original: line }) => line);
}

// Archivos que de verdad llegaron: smbclient imprime la velocidad "(x kB/s) (average
// y kB/s)" al cerrar bien cada archivo; si falla cli_push la imprime igual pero antes
// avisa con "cli_push returned", así que esos se restan.
// OJO: en samba 4.17 (imagen bookworm) y 4.22, "putting file ... (average ...)" es un
// DEBUG(1) y sale por STDERR (samba_cmdline_init -> DEBUG_DEFAULT_STDERR), entero y solo
// al terminar el archivo; los "NT_STATUS_* closing/opening remote file" salen por stdout.
// Por eso se cuentan las dos salidas (contar solo stdout daba siempre 0 con smbclient real).
export function countArrivals(stdout, stderr, names = []) {
  const count = (text, pattern) => (withoutNames(String(text || ""), names).match(pattern) || []).length;
  const finished = count(stdout, /kb\/s\)\s*\(average/gi) + count(stderr, /kb\/s\)\s*\(average/gi);
  const pushFailed = count(stdout, /cli_push returned/g) + count(stderr, /cli_push returned/g);
  return Math.max(0, finished - pushFailed);
}

function lastPuttingName(...streams) {
  const text = streams.map((part) => String(part || "")).join("\n");
  const matches = [...text.matchAll(/putting file .+? as (.+?)(?:\s|\(|$)/gi)];
  if (!matches.length) return null;
  const remote = matches[matches.length - 1][1].replaceAll("\\", "/");
  return remote.split("/").filter(Boolean).pop() || remote;
}

// Nombre del archivo que smbclient estaba cerrando cuando falló (salida real).
function basenameFromClosingLine(line) {
  const match = String(line || "").match(/closing remote file\s+(\S+)/i);
  if (!match) return null;
  const remote = match[1].replaceAll("\\", "/");
  return remote.split("/").filter(Boolean).pop() || remote;
}

function batchRemoteByBasename(batch, basename) {
  if (!basename) return null;
  const hit = batch.find((file) => {
    const rel = file.remoteRelative.replaceAll("\\", "/");
    return rel === basename || rel.endsWith(`/${basename}`) || rel.split("/").pop() === basename;
  });
  return hit?.remoteRelative || null;
}


async function smbBatch(service, user, password, commands, options = {}) {
  let output = "";
  let stdout = "";
  let stderr = "";
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  try {
    const result = await runCommand("smbclient", [service, "-U", user, "-c", commands.join("; ")], {
      input: `${password}\n`,
      signal: options.signal,
      onStdout(chunk, full) {
        stdout = full;
        if (onProgress) onProgress(full, stderr);
      },
      onStderr(chunk, full) {
        stderr = full;
        if (onProgress) onProgress(stdout, full);
      }
    });
    stdout = result.stdout || "";
    stderr = result.stderr || "";
    output = `${stdout}\n${stderr}`;
  } catch (error) {
    stdout = error.stdout || stdout || "";
    stderr = error.stderr || stderr || "";
    output = `${stdout}\n${stderr}`;
    if (error.cancelled) {
      error.putsDone = countArrivals(stdout, stderr, options.names);
      throw error;
    }
    if (!smbErrors(output, options).length) {
      error.putsDone = countArrivals(stdout, stderr, options.names);
      error.smbLine = error.message;
      error.message = translateSmbError(error.message);
      throw error;
    }
  }
  const errors = smbErrors(output, options);
  if (errors.length) {
    const smbLine = errors[0].trim();
    const error = new Error(translateSmbError(smbLine));
    error.putsDone = countArrivals(stdout, stderr, options.names);
    error.smbLine = smbLine;
    throw error;
  }
}


// Tamaño remoto via allinfo: smbclient a veces cierra bien y aun así el archivo
// no está completo; Quirón exige igualar tamaño antes de borrar en La Corte.
export async function remoteFileSize(service, user, password, remotePath, signal) {
  const result = await runCommand(
    "smbclient",
    [service, "-U", user, "-c", `allinfo ${smbQuote(remotePath)}`],
    { input: `${password}\n`, signal }
  );
  return parseAllinfoSize(`${result.stdout || ""}\n${result.stderr || ""}`);
}

export function parseAllinfoSize(text) {
  // Samba real (4.17/4.22): "stream: [::$DATA], N bytes". Algunos falsos/tests
  // imprimen "size: N". Se aceptan las dos formas.
  const match = String(text || "").match(/\bsize:\s*(\d+)/i)
    || String(text || "").match(/stream:\s*\[::\$DATA\],\s*(\d+)\s*bytes/i);
  if (!match) return null;
  return Number(match[1]);
}

export async function verifyRemoteComplete(service, user, password, file, remotePath, signal) {
  try {
    const remoteSize = await remoteFileSize(service, user, password, remotePath, signal);
    return remoteSize !== null && remoteSize === file.size;
  } catch {
    return false;
  }
}

async function deleteConfirmedLocals(service, user, password, files, arrivedCount, target, signal) {
  const deleted = [];
  const limit = Math.min(arrivedCount, files.length);
  for (let i = 0; i < limit; i += 1) {
    if (signal?.aborted) break;
    const file = files[i];
    const remotePath = path.posix.join(target.remoteDir, file.remoteRelative);
    const ok = await verifyRemoteComplete(service, user, password, file, remotePath, signal);
    if (!ok) continue;
    try {
      await fs.unlink(file.absolute);
      deleted.push(file.remoteRelative);
    } catch {
      // Si ya no está, no lo contamos como borrado.
    }
  }
  return deleted;
}

function deletedMessage(deleted) {
  if (!deleted.length) return "";
  const list = deleted.join(", ");
  return deleted.length === 1
    ? ` Se borró: ${list}.`
    : ` Se borraron: ${list}.`;
}

const FILES_PER_CONNECTION = 20;

export async function runSmb(job, target, credentials, files, dirs = []) {
  const service = `//${target.host}/${target.share}`;
  const user = credentials.domain ? `${credentials.domain}\\${credentials.username}` : credentials.username;
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0) || files.length || 1;
  let transferredBytes = 0;
  let transferredFiles = 0;
  const signal = job.abortController?.signal;

  const assertNotCancelled = () => {
    if (job.abortRequested || signal?.aborted) {
      const error = new Error("Transferencia cancelada");
      error.cancelled = true;
      error.transferred = transferredFiles;
      throw error;
    }
  };

  updateJob(job, { status: "running", percent: 1, message: "Creando carpetas remotas" });
  assertNotCancelled();
  const remoteDirs = remoteDirsFor(files, dirs, target.remoteDir);
  if (remoteDirs.length) {
    await smbBatch(service, user, credentials.password,
      remoteDirs.map((dir) => `mkdir ${smbQuote(dir)}`), { ignoreCollision: true, names: remoteDirs, signal });
  }

  // Varios archivos por conexión: con muchas imágenes pequeñas es mucho más rápido
  // que abrir una conexión SMB por archivo. El avance se lee en vivo de la salida.
  for (let index = 0; index < files.length; index += FILES_PER_CONNECTION) {
    assertNotCancelled();
    const batch = files.slice(index, index + FILES_PER_CONNECTION);
    updateJob(job, {
      message: `Transfiriendo ${batch[0].remoteRelative}${batch.length > 1 ? ` y ${batch.length - 1} más` : ""}`,
      filename: batch[0].remoteRelative
    });
    const remoteName = (file) => path.posix.join(target.remoteDir, file.remoteRelative);
    const names = batch.flatMap((file) => [file.absolute, remoteName(file)]);
    let lastSeen = 0;
    try {
      await smbBatch(service, user, credentials.password, batch.map((file) =>
        `put ${smbQuote(file.absolute)} ${smbQuote(remoteName(file))}`), {
        names,
        signal,
        onProgress(stdout, stderr) {
          const arrived = Math.min(countArrivals(stdout, stderr, names), batch.length);
          if (arrived <= lastSeen) {
            const current = lastPuttingName(stdout, stderr);
            if (current) {
              updateJob(job, {
                message: `Copiando ${current}`,
                filename: current
              });
            }
            return;
          }
          // Solo se cuenta al confirmar el cierre (average), no al empezar "putting file".
          const newly = arrived - lastSeen;
          lastSeen = arrived;
          let addedBytes = 0;
          for (let i = arrived - newly; i < arrived; i += 1) {
            addedBytes += batch[i]?.size || 1;
          }
          transferredFiles += newly;
          transferredBytes += addedBytes;
          const percent = Math.min(99, Math.round((transferredBytes / totalBytes) * 100));
          const current = batch[Math.min(arrived, batch.length - 1)]?.remoteRelative
            || lastPuttingName(stdout, stderr)
            || batch[0].remoteRelative;
          updateJob(job, {
            percent,
            filename: current,
            message: `Transferido ${formatBytes(transferredBytes)} de ${formatBytes(totalBytes)} · ${transferredFiles} de ${files.length}`
          });
        }
      });
    } catch (error) {
      if (error.cancelled) {
        error.transferred = transferredFiles + Math.max(0, (error.putsDone || 0) - lastSeen);
        throw error;
      }
      const doneInBatch = Math.min(error.putsDone || 0, batch.length);
      // Si el progreso en vivo ya contó algunos, no los volvemos a sumar.
      const missing = Math.max(0, doneInBatch - lastSeen);
      if (missing) {
        for (let i = lastSeen; i < lastSeen + missing; i += 1) {
          transferredBytes += batch[i]?.size || 1;
        }
        transferredFiles += missing;
      }
      const done = transferredFiles;
      // smbclient sigue con los demás archivos tras un fallo, así que no se dice
      // "antes del error": puede haber llegados después del que falló.
      // Corte o fallo al escribir/cerrar puede dejar un archivo a medias en El Castillo.
      // Avisamos el nombre y no lo borramos (el Rey decide; importa para "borrar después de transferir").
      // Un fallo al abrir (sin llegar a escribir) no deja resto: no se avisa.
      const raw = String(error.message || "");
      const leftPartial = /Se perdió la conexión|No hay espacio|No se pudo escribir|cli_push|closing remote|CONNECTION_|IO_TIMEOUT|DISK_FULL|NETWORK_NAME_DELETED/i.test(raw);
      // putsDone baja si el archivo a medias emite "cli_push returned" (resta un average
      // bueno anterior): no usar doneInBatch como índice. Preferir la línea "closing remote
      // file"; si no, el siguiente tras los que sí llegaron (done).
      let partialRemote = null;
      if (leftPartial) {
        partialRemote = batchRemoteByBasename(batch, basenameFromClosingLine(error.smbLine || raw))
          || batch[done]?.remoteRelative
          || null;
      }
      let detail = `${translateSmbError(error.message)}. Llegaron ${done} de ${files.length} archivos.`;
      if (partialRemote) {
        detail += ` Quedó a medias en El Castillo: ${partialRemote} (no lo borré).`;
      }
      error.message = detail;
      error.transferred = done;
      error.partialRemote = partialRemote;
      throw error;
    }
    // Si el lote terminó bien y el streaming no alcanzó a contar todos (salida de golpe),
    // sincronizamos con el tamaño del lote.
    if (lastSeen < batch.length) {
      for (let i = lastSeen; i < batch.length; i += 1) {
        transferredBytes += batch[i]?.size || 1;
      }
      transferredFiles += batch.length - lastSeen;
    }
    const percent = Math.min(100, Math.round((transferredBytes / totalBytes) * 100));
    updateJob(job, {
      percent,
      filename: batch[batch.length - 1].remoteRelative,
      message: `Transferido ${formatBytes(transferredBytes)} de ${formatBytes(totalBytes)} · ${transferredFiles} de ${files.length}`
    });
  }
  return { transferred: transferredFiles };
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
    password: requireText(password, "La contraseña SMB"),
    domain: typeof domain === "string" ? domain.trim() : ""
  };
  const { files, dirs, skippedLinks } = await collectFiles(paths);
  if (!files.length && !dirs.length) {
    const error = new Error("No hay archivos ni carpetas dentro de la selección.");
    error.statusCode = 400;
    throw error;
  }
  return { target, credentials, files, dirs, skippedLinks };
}

export async function processSmbTransfer(
  job,
  target,
  credentials,
  files,
  dirs = [],
  skippedLinks = 0,
  deleteLocalAfterTransfer = false
) {
  const linkCount = Array.isArray(skippedLinks) ? skippedLinks.length : Number(skippedLinks) || 0;
  const service = `//${target.host}/${target.share}`;
  const user = credentials.domain ? `${credentials.domain}\\${credentials.username}` : credentials.username;
  const signal = job.abortController?.signal;

  try {
    const { transferred } = await runSmb(job, target, credentials, files, dirs);
    let deletedLocal = [];
    // Borrado diferido: en éxito o error se borran solo los confirmados por tamaño;
    // en cancelación a mano no se borra nada (exigencia del Probador).
    if (deleteLocalAfterTransfer && !job.abortRequested && !signal?.aborted) {
      updateJob(job, { message: "Comprobando tamaños en El Castillo antes de borrar" });
      deletedLocal = await deleteConfirmedLocals(
        service, user, credentials.password, files, transferred, target, signal
      );
    }
    if (job.abortRequested || signal?.aborted || job.status === "cancelled") {
      if (job.status !== "cancelled") {
        updateJob(job, {
          status: "cancelled",
          message: "Transferencia cancelada",
          result: { transferred, deletedLocal: [], cancelled: true }
        });
      }
      return;
    }
    const skipped = linkCount
      ? ` (${linkCount} enlace${linkCount === 1 ? "" : "s"} simbólico${linkCount === 1 ? "" : "s"} omitido${linkCount === 1 ? "" : "s"})`
      : "";
    const countLabel = files.length
      ? `${files.length} de ${files.length} transferidos`
      : "Transferencia SMB completada";
    const result = {
      transferred: files.length,
      folders: dirs.length,
      skippedLinks: linkCount,
      target: `//${target.host}/${target.share}/${target.remoteDir}`.replace(/\/$/, "")
    };
    if (deleteLocalAfterTransfer) result.deletedLocal = deletedLocal;
    updateJob(job, {
      status: "done",
      percent: 100,
      message: `${countLabel}${skipped}${deletedMessage(deletedLocal)}`.trim(),
      result
    });
  } catch (error) {
    if (error.cancelled || job.abortRequested || job.status === "cancelled") {
      if (job.status !== "cancelled") {
        updateJob(job, {
          status: "cancelled",
          message: "Transferencia cancelada",
          result: { transferred: error.transferred ?? 0, deletedLocal: [], cancelled: true }
        });
      }
      return;
    }
    let deletedLocal = [];
    if (deleteLocalAfterTransfer) {
      try {
        deletedLocal = await deleteConfirmedLocals(
          service,
          user,
          credentials.password,
          files,
          error.transferred ?? 0,
          target,
          signal
        );
      } catch {
        deletedLocal = [];
      }
    }
    const result = {
      transferred: error.transferred ?? 0,
      total: files.length
    };
    if (deleteLocalAfterTransfer) result.deletedLocal = deletedLocal;
    if (error.partialRemote) result.partialRemote = error.partialRemote;
    const detail = `${error.message}${deletedMessage(deletedLocal)}`;
    updateJob(job, {
      status: "error",
      error: detail,
      message: "Transferencia fallida",
      result
    });
  }
}

export async function cancelSmbTransferJob(job) {
  if (!job || job.type !== "smb-transfer") {
    const error = new Error("Solo se pueden cancelar transferencias SMB.");
    error.statusCode = 400;
    throw error;
  }
  if (job.status === "done" || job.status === "error" || job.status === "cancelled") {
    const error = new Error("Ese trabajo ya terminó.");
    error.statusCode = 409;
    throw error;
  }
  if (!job.cancellable) {
    const error = new Error("Esa transferencia ya no se puede cancelar.");
    error.statusCode = 409;
    throw error;
  }
  job.abortRequested = true;
  try {
    job.abortController?.abort();
  } catch {
    // ignore
  }
  updateJob(job, {
    status: "cancelled",
    message: "Transferencia cancelada",
    error: null,
    result: { ...(job.result || {}), deletedLocal: [], cancelled: true }
  });
  return {
    id: job.id,
    status: job.status,
    message: job.message
  };
}
