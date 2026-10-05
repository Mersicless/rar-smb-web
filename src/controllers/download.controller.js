import { enqueueDownload } from "../services/download.service.js";
import { createJob, publicJob } from "../services/job.service.js";
import { optionalText, requireText } from "../utils/validation.js";

export async function createDownload(request, response) {
  const url = requireText(request.body.url, "La URL");
  const archivePassword = optionalText(request.body.archivePassword);
  const deleteArchiveAfterExtract = Boolean(request.body.deleteArchiveAfterExtract);
  const job = createJob("download");
  response.status(202).json(publicJob(job));

  // Fire-and-forget: la cola limita a 3 descargas en paralelo.
  enqueueDownload(job, url, archivePassword, deleteArchiveAfterExtract);
}
