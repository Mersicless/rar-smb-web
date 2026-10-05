import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { DOWNLOAD_DIR } from "../config/paths.js";
import { requireText } from "../utils/validation.js";

export async function ensureDownloadDirectory() {
  await fs.mkdir(DOWNLOAD_DIR, { recursive: true });
}

// Caracteres que no valen en un nombre de archivo en Linux, Windows o SMB.
// Se permiten letras con tildes, ñ y cualquier letra Unicode.
const INVALID_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

export function safeName(value, fallback = "descarga") {
  let decoded = String(value || "");
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Nombre con % sueltos: se usa tal cual.
  }
  decoded = decoded.replaceAll("\\", "/").split("/").pop().normalize("NFC");
  const cleaned = decoded.replace(INVALID_NAME_CHARS, "_").replace(/^[. ]+|[. ]+$/g, "");
  return cleaned || fallback;
}

// Límite de la mayoría de sistemas de archivos (ext4, NTFS vía SMB): 255 bytes por nombre.
const MAX_NAME_BYTES = 255;

export function validateName(value, label = "El nombre") {
  const cleanName = requireText(value, label).normalize("NFC");
  if (Buffer.byteLength(cleanName, "utf8") > MAX_NAME_BYTES) {
    throw httpError(400, `El nombre es demasiado largo (máximo ${MAX_NAME_BYTES} bytes).`);
  }
  if (cleanName === "." || cleanName === ".." || /[\\/:*?"<>|\u0000-\u001f]/.test(cleanName)) {
    throw httpError(400, 'El nombre no puede contener rutas ni estos caracteres: \\ / : * ? " < > |');
  }
  if (/[. ]$/.test(cleanName)) {
    throw httpError(400, "El nombre no puede terminar en punto ni en espacio.");
  }
  return cleanName;
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

// existsSync sigue los enlaces: un enlace roto da false y fs.rename o
// createWriteStream lo pisarían (o escribirían a donde apunta). lstat no lo sigue.
export function entryExists(absolute) {
  try {
    fssync.lstatSync(absolute);
    return true;
  } catch {
    return false;
  }
}

// La raíz de descargas puede ser ella misma un enlace (p. ej. DOWNLOAD_DIR=/srv/descargas
// -> /mnt/disco): para la raíz se sigue el enlace; para lo de dentro, no.
function statEntry(absolute) {
  return (absolute === DOWNLOAD_DIR ? fs.stat(absolute) : fs.lstat(absolute)).catch(() => null);
}

function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function realRoot() {
  return fs.realpath(DOWNLOAD_DIR);
}

// Comprueba a dónde apunta de verdad una ruta existente (sigue enlaces simbólicos).
export async function assertRealInside(absolute) {
  const real = await fs.realpath(absolute).catch(() => null);
  if (!real || !isInside(await realRoot(), real)) {
    throw httpError(400, "Ruta fuera del repositorio de descargas.");
  }
  return real;
}

// Para operar sobre el elemento mismo (renombrar, mover, borrar): su carpeta
// contenedora real debe estar dentro de descargas. Si el elemento es un enlace,
// se opera sobre el enlace, nunca sobre lo que apunta.
async function assertParentInside(absolute) {
  return assertRealInside(path.dirname(absolute));
}

export async function uniquePath(directory, filename) {
  const parsed = path.parse(filename);
  let candidate = path.join(directory, filename);
  let index = 1;
  while (entryExists(candidate)) {
    candidate = path.join(directory, `${parsed.name}_${index}${parsed.ext}`);
    index += 1;
  }
  return candidate;
}

export function relativeFromRoot(absolutePath) {
  return path.relative(DOWNLOAD_DIR, absolutePath).replaceAll(path.sep, "/") || ".";
}

export function resolveInsideDownloads(relativePath = ".") {
  const clean = String(relativePath || ".").replaceAll("\\", "/");
  const resolved = path.resolve(DOWNLOAD_DIR, clean);
  if (resolved !== DOWNLOAD_DIR && !resolved.startsWith(`${DOWNLOAD_DIR}${path.sep}`)) {
    const error = new Error("Ruta fuera del repositorio de descargas.");
    error.statusCode = 400;
    throw error;
  }
  return resolved;
}

function entryType(dirent) {
  if (dirent.isSymbolicLink()) return "symlink";
  return dirent.isDirectory() ? "directory" : "file";
}

export async function listTree(root) {
  const entries = [];
  async function walk(current) {
    const children = await fs.readdir(current, { withFileTypes: true });
    for (const child of children) {
      const absolute = path.join(current, child.name);
      const stat = await fs.lstat(absolute);
      entries.push({
        name: child.name,
        path: relativeFromRoot(absolute),
        type: entryType(child),
        size: stat.size,
        modifiedAt: stat.mtime.toISOString()
      });
      if (child.isDirectory()) await walk(absolute);
    }
  }
  await walk(root);
  return entries;
}

export async function listDirectory(relativePath) {
  const absolute = resolveInsideDownloads(relativePath);
  const stat = await statEntry(absolute);
  if (!stat || !stat.isDirectory()) {
    const error = new Error("La ruta no existe o no es una carpeta.");
    error.statusCode = 404;
    throw error;
  }
  const entries = (await fs.readdir(absolute, { withFileTypes: true }))
    .filter((entry) => entry.name !== ".gitkeep");
  const items = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(absolute, entry.name);
    const entryStat = await fs.lstat(entryPath);
    return {
      name: entry.name,
      path: relativeFromRoot(entryPath),
      type: entryType(entry),
      size: entryStat.size,
      modifiedAt: entryStat.mtime.toISOString()
    };
  }));
  await assertRealInside(absolute);
  items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1));
  return {
    cwd: relativeFromRoot(absolute),
    parent: absolute === DOWNLOAD_DIR ? null : relativeFromRoot(path.dirname(absolute)),
    items
  };
}

export async function removePaths(relativePaths) {
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
    await assertParentInside(absolute);
    await fs.rm(absolute, { recursive: true, force: true });
  }
}

export async function renamePath(relativePath, newName) {
  const absolute = resolveInsideDownloads(relativePath);
  if (absolute === DOWNLOAD_DIR) {
    throw httpError(400, "No se puede renombrar la carpeta raiz de descargas.");
  }
  await assertParentInside(absolute);
  if (!(await fs.lstat(absolute).catch(() => null))) {
    throw httpError(404, "El archivo o carpeta ya no existe.");
  }
  const cleanName = validateName(newName, "El nuevo nombre");
  const target = resolveInsideDownloads(path.join(path.dirname(relativeFromRoot(absolute)), cleanName));
  if (target === absolute) return relativeFromRoot(absolute);
  if (entryExists(target)) {
    throw httpError(409, "Ya existe un archivo o carpeta con ese nombre.");
  }
  await fs.rename(absolute, target);
  return relativeFromRoot(target);
}

export async function createFolder(parentRelative, name) {
  const parent = resolveInsideDownloads(parentRelative || ".");
  const parentStat = await statEntry(parent);
  if (!parentStat || !parentStat.isDirectory()) {
    throw httpError(404, "La carpeta donde quieres crearla no existe.");
  }
  await assertRealInside(parent);
  const cleanName = validateName(name, "El nombre de la carpeta");
  const target = resolveInsideDownloads(path.join(relativeFromRoot(parent), cleanName));
  if (entryExists(target)) {
    throw httpError(409, "Ya existe un archivo o carpeta con ese nombre.");
  }
  await fs.mkdir(target);
  return relativeFromRoot(target);
}

export async function movePaths(relativePaths, destinationRelative) {
  if (!Array.isArray(relativePaths) || relativePaths.length === 0) {
    throw httpError(400, "Selecciona al menos un archivo o carpeta para mover.");
  }
  const destination = resolveInsideDownloads(destinationRelative || ".");
  const destStat = await statEntry(destination);
  if (!destStat || !destStat.isDirectory()) {
    throw httpError(400, "El destino no existe o no es una carpeta.");
  }
  const realDestination = await assertRealInside(destination);

  // Primero se valida todo; solo si todo está bien se mueve algo.
  const plan = [];
  const targets = new Set();
  for (const relativePath of relativePaths) {
    const source = resolveInsideDownloads(relativePath);
    if (source === DOWNLOAD_DIR) throw httpError(400, "No se puede mover la carpeta raiz de descargas.");
    const sourceStat = await fs.lstat(source).catch(() => null);
    if (!sourceStat) throw httpError(404, `Ya no existe: ${relativePath}`);
    const realParent = await assertParentInside(source);
    const realSource = path.join(realParent, path.basename(source));
    if (sourceStat.isDirectory() && isInside(realSource, realDestination)) {
      throw httpError(400, `No se puede mover "${path.basename(source)}" dentro de sí misma.`);
    }
    if (realParent === realDestination) continue; // ya está ahí
    const target = path.join(destination, path.basename(source));
    if (entryExists(target) || targets.has(target)) {
      throw httpError(409, `En el destino ya existe "${path.basename(source)}". No se movió nada.`);
    }
    targets.add(target);
    plan.push({ source, target });
  }
  for (const { source, target } of plan) {
    await fs.rename(source, target);
  }
  return { moved: plan.length, destination: relativeFromRoot(destination) };
}

// Reúne lo que se va a transferir. Los enlaces simbólicos se omiten siempre:
// un enlace dentro de un RAR podría apuntar fuera de descargas.
export async function collectFiles(relativePaths) {
  const files = [];
  const dirs = [];
  let skippedLinks = 0;
  for (const relativePath of relativePaths) {
    const absolute = resolveInsideDownloads(relativePath);
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) {
      skippedLinks += 1;
      continue;
    }
    await assertParentInside(absolute);
    if (stat.isDirectory()) {
      skippedLinks += await collectFromDirectory(absolute, files, dirs);
    } else if (stat.isFile()) {
      files.push({ absolute, remoteRelative: path.basename(absolute), size: stat.size });
    }
  }
  return { files, dirs, skippedLinks };
}

async function collectFromDirectory(directory, files, dirs) {
  const rootName = path.basename(directory);
  let skippedLinks = 0;
  dirs.push(rootName);
  async function walk(current) {
    const children = await fs.readdir(current, { withFileTypes: true });
    for (const child of children) {
      const absolute = path.join(current, child.name);
      const inside = path.relative(directory, absolute).replaceAll(path.sep, "/");
      const remoteRelative = path.posix.join(rootName, inside);
      if (child.isSymbolicLink()) {
        skippedLinks += 1;
      } else if (child.isDirectory()) {
        dirs.push(remoteRelative);
        await walk(absolute);
      } else if (child.isFile()) {
        const stat = await fs.lstat(absolute);
        files.push({ absolute, remoteRelative, size: stat.size });
      }
    }
  }
  await walk(directory);
  return skippedLinks;
}
