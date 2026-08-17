import { getJob, publicJob } from "../services/job.service.js";

export function getJobStatus(request, response) {
  const job = getJob(request.params.id);
  if (!job) {
    response.status(404).json({ error: "Trabajo no encontrado." });
    return;
  }
  response.json(publicJob(job));
}

export function streamJobEvents(request, response) {
  const job = getJob(request.params.id);
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
}

