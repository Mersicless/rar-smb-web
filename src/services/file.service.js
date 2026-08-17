import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { DOWNLOAD_DIR } from "../config/paths.js";
import { requireText } from "../utils/validation.js";

export async function ensureDownloadDirectory() {
  await fs.mkdir(DOWNLOAD_DIR, { recursive: true });
}

export function safeName(value, fallback = "descarga") {
  const decoded = decodeURIComponent(String(value || "")).replaceAll("\\", "/").split("/").pop();
  const cleaned = decoded.replace(/[^A-Za-z0-9._ -]/g, "_").replace(/^[. ]+|[. ]+$/g, "");
  return cleaned || fallback;
}

export async function uniquePath(directory, filename) {
  const parsed = path.parse(filename);
  let candidate = path.join(directory, filename);
  let index = 1;
  while (fssync.existsSync(candidate)) {
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

export async function listTree(root) {
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
      if (child.isDirectory()) await walk(absolute);
    }
  }
  await walk(root);
  return entries;
}

export async function listDirectory(relativePath) {
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
    await fs.rm(absolute, { recursive: true, force: true });
  }
}

export async function renamePath(relativePath, newName) {
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
  if (target === absolute) return relativeFromRoot(absolute);
  if (fssync.existsSync(target)) {
    const error = new Error("Ya existe un archivo o carpeta con ese nombre.");
    error.statusCode = 409;
    throw error;
  }
  await fs.rename(absolute, target);
  return relativeFromRoot(target);
}

export async function collectFiles(relativePaths) {
  const files = [];
  for (const relativePath of relativePaths) {
    const absolute = resolveInsideDownloads(relativePath);
    const stat = await fs.stat(absolute);
    if (stat.isDirectory()) {
      await collectFromDirectory(absolute, ".", files);
    } else {
      files.push({ absolute, remoteRelative: path.basename(absolute), size: stat.size });
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

