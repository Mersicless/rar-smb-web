import { Router } from "express";
import { deleteFiles, listFiles, makeFolder, moveFiles, renameFile } from "../controllers/file.controller.js";
import { handleAsync } from "../middlewares/async-handler.js";

const router = Router();
router.get("/", handleAsync(listFiles));
router.delete("/", handleAsync(deleteFiles));
router.patch("/rename", handleAsync(renameFile));
router.post("/folder", handleAsync(makeFolder));
router.post("/move", handleAsync(moveFiles));
export default router;
