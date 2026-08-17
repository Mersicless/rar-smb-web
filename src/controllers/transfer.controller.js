import { createJob, publicJob } from "../services/job.service.js";
import { prepareSmbTransfer, processSmbTransfer } from "../services/smb.service.js";

export async function createTransfer(request, response) {
  const { target, credentials, files } = await prepareSmbTransfer(request.body);

  const job = createJob("smb-transfer");
  response.status(202).json(publicJob(job));
  await processSmbTransfer(job, target, credentials, files);
}
