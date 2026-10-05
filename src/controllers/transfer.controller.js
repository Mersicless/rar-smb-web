import { createJob, publicJob } from "../services/job.service.js";
import { prepareSmbTransfer, processSmbTransfer } from "../services/smb.service.js";

export async function createTransfer(request, response) {
  const deleteLocalAfterTransfer = Boolean(request.body.deleteLocalAfterTransfer);
  const { target, credentials, files, dirs, skippedLinks } = await prepareSmbTransfer(request.body);

  const job = createJob("smb-transfer");
  job.cancellable = true;
  job.abortController = new AbortController();
  response.status(202).json(publicJob(job));
  await processSmbTransfer(job, target, credentials, files, dirs, skippedLinks, deleteLocalAfterTransfer);
}
