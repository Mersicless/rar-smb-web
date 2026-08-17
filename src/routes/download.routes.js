import { Router } from "express";
import { createDownload } from "../controllers/download.controller.js";
import { handleAsync } from "../middlewares/async-handler.js";

const router = Router();
router.post("/", handleAsync(createDownload));
export default router;

