import { Router } from "express";
import { createTransfer } from "../controllers/transfer.controller.js";
import { handleAsync } from "../middlewares/async-handler.js";

const router = Router();
router.post("/", handleAsync(createTransfer));
export default router;

