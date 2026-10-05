import { Router } from "express";
import { cancelJob, getJobStatus, listJobStatuses, streamAllJobEvents, streamJobEvents } from "../controllers/job.controller.js";
import { handleAsync } from "../middlewares/async-handler.js";

const router = Router();
router.get("/", listJobStatuses);
router.get("/events", streamAllJobEvents);
router.get("/:id", getJobStatus);
router.get("/:id/events", streamJobEvents);
router.post("/:id/cancel", handleAsync(cancelJob));
router.delete("/:id", handleAsync(cancelJob));
export default router;
