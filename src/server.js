import crypto from "node:crypto";
import fs from "node:fs/promises";
import fssync from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import express from "express";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_DIR = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(PROJECT_DIR, "public");
const DOWNLOAD_DIR = path.resolve(process.env.DOWNLOAD_DIR || path.join(PROJECT_DIR, "downloads"));
const PORT = Number(process.env.PORT || 3000);
const CHUNK_SIZE = 1024 * 1024;
const ARCHIVE_EXTENSIONS = new Set([
  ".7z",
  ".bz2",
  ".gz",
  ".lzma",
  ".rar",
  ".tar",
  ".tbz",
  ".tbz2",
  ".tgz",
  ".txz",
  ".xz",
  ".zip"
]);

const app = express();
const jobs = new Map();

app.use(express.json({ limit: "2mb" }));
app.use(express.static(PUBLIC_DIR));

await fs.mkdir(DOWNLOAD_DIR, { recursive: true });

function createJob(type) {
  const id = crypto.randomUUID();
  const job = {
    id,
    type,
    status: "queued",
    percent: 0,
    message: "En cola",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    result: null,
    error: null,
    listeners: new Set()
  };
  jobs.set(id, job);
  return job;
}

function publicJob(job) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    percent: job.percent,
    message: job.message,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    result: job.result,
    error: job.error
  };
}

function updateJob(job, patch) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  const payload = `data: ${JSON.stringify(publicJob(job))}\n\n`;
  for (const response of job.listeners) {
    response.write(payload);
  }
}

function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    const error = new Error(`${label} es obligatorio.`);
    error.statusCode = 400;
    throw error;
  }
  return value.trim();
}

function optionalText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function safeName(value, fallback = "descarga") {
  const decoded = decodeURIComponent(String(value || "")).replaceAll("\\", "/").split("/").pop();
  const cleaned = decoded.replace(/[^A-Za-z0-9._ -]/g, "_").replace(/^[. ]+|[. ]+$/g, "");
  return cleaned || fallback;
}

function filenameFromHeaders(url, response) {
  const disposition = response.headers.get("content-disposition") || "";
  const match = disposition.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
  if (match) {
    return safeName(match[1]);
  }
  const parsed = new URL(response.url || url);
  return safeName(path.basename(parsed.pathname), "archivo.rar");
}

async function uniquePath(directory, filename) {
  const parsed = path.parse(filename);
  let candidate = path.join(directory, filename);
  let index = 1;
  while (fssync.existsSync(candidate)) {
    candidate = path.join(directory, `${parsed.name}_${index}${parsed.ext}`);
    index += 1;
  }
  return candidate;
}

function relativeFromRoot(absolutePath) {
  return path.relative(DOWNLOAD_DIR, absolutePath).replaceAll(path.sep, "/") || ".";
}

function isArchivePath(filePath) {
  return ARCHIVE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function resolveInsideDownloads(relativePath = ".") {
  const clean = String(relativePath || ".").replaceAll("\\", "/");
  const resolved = path.resolve(DOWNLOAD_DIR, clean);
  if (resolved !== DOWNLOAD_DIR && !resolved.startsWith(`${DOWNLOAD_DIR}${path.sep}`)) {
    const error = new Error("Ruta fuera del repositorio de descargas.");
    error.statusCode = 400;
    throw error;
  }
  return resolved;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: options.input ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const message = (stderr || stdout || `${command} salio con codigo ${code}`).trim();
        const error = new Error(message);
        error.code = code;
        reject(error);
      }
    });
    if (options.input) {
      child.stdin.end(options.input);
    }
  });
}

function commandExists(command) {
  const pathDirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  return pathDirs.some((directory) => {
    const commandPath = path.join(directory, command);
    try {
      fssync.accessSync(commandPath, fssync.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function firstAvailableCommand(commands) {
  return commands.find((command) => commandExists(command)) || null;
}

function startsWithBytes(buffer, bytes) {
  return bytes.every((byte, index) => buffer[index] === byte);
}

function printablePrefix(buffer) {
  return buffer
    .toString("utf8")
    .replace(/[^\x20-\x7E]+/g, " ")
    .trim()
    .slice(0, 90);
}

async function assertArchiveLooksValid(archivePath) {
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
  if (!check || check(prefix)) {
    return;
  }

  const preview = printablePrefix(prefix);
  const extra = preview ? ` Primeros bytes: "${preview}"` : "";
  throw new Error(`El archivo descargado se llama ${extension}, pero no tiene firma de archivo comprimido valida.${extra}`);
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

async function downloadArchive(job, url) {
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

async function extractArchive(job, archivePath, archivePassword) {
  const extractDir = await uniquePath(DOWNLOAD_DIR, `${path.parse(archivePath).name}_extraido`);
  await fs.mkdir(extractDir, { recursive: true });
  updateJob(job, { percent: 75, message: "Descomprimiendo archivo comprimido" });

  const unrar = firstAvailableCommand(["unrar", "unrar-nonfree"]);
  if (path.extname(archivePath).toLowerCase() === ".rar" && unrar) {
    await runUnrar(unrar, archivePath, extractDir, archivePassword);
    updateJob(job, { percent: 90, message: "Leyendo contenido extraido" });
    const extracted = await listTree(extractDir);
    return { extractDir, extracted };
  }

  const sevenZip = firstAvailableCommand(["7zz", "7z"]);
  if (sevenZip) {
    try {
      await runCommand(sevenZip, [
        "x",
        "-y",
        `-p${archivePassword}`,
        `-o${extractDir}`,
        archivePath
      ]);
    } catch (error) {
      if (!commandExists("unar")) {
        throw error;
      }
      updateJob(job, { message: "7-Zip fallo; probando extractor alterno" });
      await runUnarFallback(archivePath, extractDir, archivePassword, error);
    }
  } else if (commandExists("unar")) {
    await runUnarFallback(archivePath, extractDir, archivePassword);
  } else {
    throw new Error("No hay extractor instalado. Instala unrar, 7zip o unar.");
  }

  updateJob(job, { percent: 90, message: "Leyendo contenido extraido" });
  const extracted = await listTree(extractDir);
  return { extractDir, extracted };
}

async function runUnrar(command, archivePath, extractDir, archivePassword) {
  await runCommand(command, [
    "x",
    "-idq",
    "-o+",
    `-p${archivePassword}`,
    archivePath,
    `${extractDir}${path.sep}`
  ]);
}

async function runUnarFallback(archivePath, extractDir, archivePassword, previousError = null) {
  try {
    await runCommand("unar", [
      "-quiet",
      "-password",
      archivePassword,
      "-output-directory",
      extractDir,
      archivePath
    ]);
  } catch (error) {
    if (!previousError) {
      throw error;
    }
    throw new Error(`7-Zip no pudo extraer el archivo: ${previousError.message}\nunar tampoco pudo extraerlo: ${error.message}`);
  }
}

async function listTree(root) {
  const entries = [];
  async function walk(current) {
    const children = await fs.readdir(current, { withFileTypes: true });
    for (const child of children) {
      const absolute = path.join(current, child.name);
      const stat = await fs.stat(absolute);
      entries.push({
        name: child.name,
        path: relativeFromRoot(absolute),
        type: child.isDirectory() ? "directory" : "file",
        size: stat.size,
        modifiedAt: stat.mtime.toISOString()
      });
      if (child.isDirectory()) {
        await walk(absolute);
      }
    }
  }
  await walk(root);
  return entries;
}

async function listDirectory(relativePath) {
  const absolute = resolveInsideDownloads(relativePath);
  const stat = await fs.stat(absolute).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    const error = new Error("La ruta no existe o no es una carpeta.");
    error.statusCode = 404;
    throw error;
  }
  const entries = (await fs.readdir(absolute, { withFileTypes: true }))
    .filter((entry) => entry.name !== ".gitkeep");
  const items = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(absolute, entry.name);
    const entryStat = await fs.stat(entryPath);
    return {
      name: entry.name,
      path: relativeFromRoot(entryPath),
      type: entry.isDirectory() ? "directory" : "file",
      size: entryStat.size,
      modifiedAt: entryStat.mtime.toISOString()
    };
  }));
  items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1));
  return {
    cwd: relativeFromRoot(absolute),
    parent: absolute === DOWNLOAD_DIR ? null : relativeFromRoot(path.dirname(absolute)),
    items
  };
}

async function removePaths(relativePaths) {
  if (!Array.isArray(relativePaths) || relativePaths.length === 0) {
    const error = new Error("Selecciona al menos un archivo o carpeta.");
    error.statusCode = 400;
    throw error;
  }
  for (const relativePath of relativePaths) {
    const absolute = resolveInsideDownloads(relativePath);
    if (absolute === DOWNLOAD_DIR) {
      const error = new Error("No se puede borrar la carpeta raiz de descargas.");
      error.statusCode = 400;
      throw error;
    }
    await fs.rm(absolute, { recursive: true, force: true });
  }
}

async function renamePath(relativePath, newName) {
  const absolute = resolveInsideDownloads(relativePath);
  if (absolute === DOWNLOAD_DIR) {
    const error = new Error("No se puede renombrar la carpeta raiz de descargas.");
    error.statusCode = 400;
    throw error;
  }

  const cleanName = requireText(newName, "El nuevo nombre");
  if (cleanName === "." || cleanName === ".." || /[\\/:\0\r\n]/.test(cleanName)) {
    const error = new Error("El nombre no puede contener rutas ni caracteres no validos.");
    error.statusCode = 400;
    throw error;
  }

  const target = resolveInsideDownloads(path.join(path.dirname(relativeFromRoot(absolute)), cleanName));
  if (target === absolute) {
    return relativeFromRoot(absolute);
  }
  if (fssync.existsSync(target)) {
    const error = new Error("Ya existe un archivo o carpeta con ese nombre.");
    error.statusCode = 409;
    throw error;
  }
  await fs.rename(absolute, target);
  return relativeFromRoot(target);
}

function parseSmbTarget(input) {
  const route = requireText(input.route, "La ruta SMB");
  const normalized = route.replaceAll("\\", "/").replace(/^smb:/i, "");
  const match = normalized.match(/^\/\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
  if (!match) {
    const error = new Error("La ruta SMB debe tener formato //servidor/recurso/carpeta.");
    error.statusCode = 400;
    throw error;
  }
  return {
    host: match[1],
    share: match[2],
    remoteDir: (match[3] || "").replace(/^\/+|\/+$/g, "")
  };
}

function smbQuote(value) {
  const text = String(value);
  if (/[";\r\n]/.test(text)) {
    throw new Error(`Nombre no compatible con SMB: ${text}`);
  }
  return `"${text}"`;
}

async function collectFiles(relativePaths) {
  const files = [];
  for (const relativePath of relativePaths) {
    const absolute = resolveInsideDownloads(relativePath);
    const stat = await fs.stat(absolute);
    if (stat.isDirectory()) {
      await collectFromDirectory(absolute, ".", files);
    } else {
      files.push({
        absolute,
        remoteRelative: path.basename(absolute),
        size: stat.size
      });
    }
  }
  return files;
}

async function collectFromDirectory(directory, baseRelative, files) {
  const rootName = path.basename(directory);
  async function walk(current) {
    const children = await fs.readdir(current, { withFileTypes: true });
    for (const child of children) {
      const absolute = path.join(current, child.name);
      const stat = await fs.stat(absolute);
      if (child.isDirectory()) {
        await walk(absolute);
      } else {
        const inside = path.relative(directory, absolute).replaceAll(path.sep, "/");
        files.push({
          absolute,
          remoteRelative: path.posix.join(baseRelative === "." ? "" : baseRelative, rootName, inside),
          size: stat.size
        });
      }
    }
  }
  await walk(directory);
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

async function runSmb(job, target, credentials, files) {
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
      if (!/NT_STATUS_OBJECT_NAME_COLLISION|ERRDOS - ERRfilexists/i.test(error.message)) {
        throw error;
      }
    });
  }

  for (const file of files) {
    const remotePath = path.posix.join(target.remoteDir, file.remoteRelative);
    updateJob(job, { message: `Transfiriendo ${file.remoteRelative}` });
    await runCommand("smbclient", [
      service,
      "-U",
      user,
      "-c",
      `put ${smbQuote(file.absolute)} ${smbQuote(remotePath)}`
    ], {
      input: `${credentials.password}\n`
    });
    transferredBytes += file.size || 1;
    const percent = Math.min(100, Math.round((transferredBytes / totalBytes) * 100));
    updateJob(job, { percent, message: `Transferido ${formatBytes(transferredBytes)} de ${formatBytes(totalBytes)}` });
  }
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function handleAsync(fn) {
  return (request, response, next) => {
    Promise.resolve(fn(request, response, next)).catch(next);
  };
}

app.post("/api/download", handleAsync(async (request, response) => {
  const url = requireText(request.body.url, "La URL");
  const archivePassword = optionalText(request.body.archivePassword);
  const job = createJob("download");
  response.status(202).json(publicJob(job));

  try {
    const archivePath = await downloadArchive(job, url);
    if (!isArchivePath(archivePath)) {
      updateJob(job, {
        status: "done",
        percent: 100,
        message: "Descarga completada",
        result: {
          file: relativeFromRoot(archivePath)
        }
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
}));

app.get("/api/jobs/:id", (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job) {
    response.status(404).json({ error: "Trabajo no encontrado." });
    return;
  }
  response.json(publicJob(job));
});

app.get("/api/jobs/:id/events", (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job) {
    response.status(404).end();
    return;
  }
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });
  response.write(`data: ${JSON.stringify(publicJob(job))}\n\n`);
  job.listeners.add(response);
  request.on("close", () => job.listeners.delete(response));
});

app.get("/api/files", handleAsync(async (request, response) => {
  response.json(await listDirectory(request.query.path || "."));
}));

app.delete("/api/files", handleAsync(async (request, response) => {
  await removePaths(request.body.paths);
  response.json({ ok: true });
}));

app.patch("/api/files/rename", handleAsync(async (request, response) => {
  const pathAfterRename = await renamePath(request.body.path, request.body.newName);
  response.json({ ok: true, path: pathAfterRename });
}));

app.post("/api/transfer", handleAsync(async (request, response) => {
  const paths = request.body.paths;
  if (!Array.isArray(paths) || paths.length === 0) {
    const error = new Error("Selecciona al menos un archivo para transferir.");
    error.statusCode = 400;
    throw error;
  }
  const target = parseSmbTarget({ route: request.body.route });
  const credentials = {
    username: requireText(request.body.username, "El usuario SMB"),
    password: requireText(request.body.password, "La contrasena SMB"),
    domain: typeof request.body.domain === "string" ? request.body.domain.trim() : ""
  };
  const files = await collectFiles(paths);
  if (!files.length) {
    const error = new Error("No hay archivos dentro de la seleccion.");
    error.statusCode = 400;
    throw error;
  }

  const job = createJob("smb-transfer");
  response.status(202).json(publicJob(job));

  try {
    await runSmb(job, target, credentials, files);
    updateJob(job, {
      status: "done",
      percent: 100,
      message: "Transferencia SMB completada",
      result: { transferred: files.length, target: `//${target.host}/${target.share}/${target.remoteDir}`.replace(/\/$/, "") }
    });
  } catch (error) {
    updateJob(job, { status: "error", error: error.message, message: "Transferencia fallida" });
  }
}));

app.use("/api/downloads", express.static(DOWNLOAD_DIR, {
  dotfiles: "deny",
  index: false
}));

app.use((error, request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }
  response.status(error.statusCode || 500).json({ error: error.message || "Error interno." });
});

const server = http.createServer(app);
server.listen(PORT, "0.0.0.0", () => {
  console.log(`RAR SMB Web listo en http://localhost:${PORT}`);
  console.log(`Repositorio de descargas: ${DOWNLOAD_DIR}`);
});
