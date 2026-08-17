import { Router } from "express";
import { deleteFiles, listFiles, renameFile } from "../controllers/file.controller.js";
import { handleAsync } from "../middlewares/async-handler.js";

const router = Router();
router.get("/", handleAsync(listFiles));
router.delete("/", handleAsync(deleteFiles));
router.patch("/rename", handleAsync(renameFile));
export default router;

