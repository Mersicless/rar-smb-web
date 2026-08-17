import { Router } from "express";
import { getJobStatus, streamJobEvents } from "../controllers/job.controller.js";

const router = Router();
router.get("/:id", getJobStatus);
router.get("/:id/events", streamJobEvents);
export default router;

