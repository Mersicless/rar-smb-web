import { processDownload } from "../services/download.service.js";
import { createJob, publicJob } from "../services/job.service.js";
import { optionalText, requireText } from "../utils/validation.js";

export async function createDownload(request, response) {
  const url = requireText(request.body.url, "La URL");
  const archivePassword = optionalText(request.body.archivePassword);
  const job = createJob("download");
  response.status(202).json(publicJob(job));

  await processDownload(job, url, archivePassword);
}
