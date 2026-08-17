import { listDirectory, removePaths, renamePath } from "../services/file.service.js";

export async function listFiles(request, response) {
  response.json(await listDirectory(request.query.path || "."));
}

export async function deleteFiles(request, response) {
  await removePaths(request.body.paths);
  response.json({ ok: true });
}

export async function renameFile(request, response) {
  const pathAfterRename = await renamePath(request.body.path, request.body.newName);
  response.json({ ok: true, path: pathAfterRename });
}

