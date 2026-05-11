import { Router } from "express";
import { auth } from "../middlewares/auth.middleware.js";
import { chatMessage, chatMessageStream } from "../controllers/chat.controllers.js";
import { adminOnly } from "../middlewares/admin.middleware.js";

const router = Router();

/** SSE stream: typing + text deltas — same body as /message */
router.post("/message/stream", auth, adminOnly, chatMessageStream);

/** JSON reply — send { "message": "..." } or { "query": "..." } */
router.post("/message", auth, adminOnly, chatMessage);

export default router;
