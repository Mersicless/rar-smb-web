import { cancelDownloadJob } from "../services/download.service.js";
import { cancelSmbTransferJob } from "../services/smb.service.js";
import { addGlobalListener, getJob, listJobs, publicJob } from "../services/job.service.js";

export function listJobStatuses(request, response) {
  const activeOnly = String(request.query.active || "") === "1"
    || String(request.query.active || "").toLowerCase() === "true";
  response.json(listJobs({ activeOnly }));
}

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

// Un solo canal para todos los trabajos: al conectar manda el estado de los activos
// y luego cada cambio de cualquier trabajo (con el mismo límite de 500 ms por trabajo).
export function streamAllJobEvents(request, response) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });
  for (const job of listJobs({ activeOnly: true })) {
    response.write(`data: ${JSON.stringify(job)}\n\n`);
  }
  const remove = addGlobalListener(response);
  const heartbeat = setInterval(() => response.write(": ping\n\n"), 25000);
  request.on("close", () => {
    clearInterval(heartbeat);
    remove();
  });
}

export async function cancelJob(request, response) {
  const job = getJob(request.params.id);
  if (!job) {
    response.status(404).json({ error: "Trabajo no encontrado." });
    return;
  }
  const result = job.type === "smb-transfer"
    ? await cancelSmbTransferJob(job)
    : await cancelDownloadJob(job);
  response.json(result);
}
