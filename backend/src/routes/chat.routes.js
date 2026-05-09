import { Router } from "express";
import { auth } from "../middlewares/auth.middleware.js";
import { chatMessage } from "../controllers/chat.controllers.js";

const router = Router();

/** Logged-in users only — send { "message": "..." } or { "query": "..." } */
router.post("/message", auth, chatMessage);

export default router;
