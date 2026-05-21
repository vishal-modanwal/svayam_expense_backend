import { Router } from "express";
import { executeDefaultBudgetRollover } from "../jobs/monthlyBudgetCron.js";

const router = Router();

/**
 * Manual rollover for testing / ops (optional).
 * Requires header: X-Cron-Secret: <CRON_MANUAL_SECRET>
 * Body (optional): { "month": 6, "year": 2026 }
 */
router.post("/rollover-default-budgets", async (req, res) => {
    const secret = process.env.CRON_MANUAL_SECRET;
    if (!secret || String(secret).trim() === "") {
        return res.status(404).json({ message: "Manual cron endpoint is not configured." });
    }

    const provided = String(req.headers["x-cron-secret"] ?? "").trim();
    if (!provided || provided !== String(secret).trim()) {
        return res.status(403).json({ message: "Invalid or missing X-Cron-Secret." });
    }

    const month =
        req.body?.month !== undefined
            ? parseInt(String(req.body.month), 10)
            : undefined;
    const year =
        req.body?.year !== undefined
            ? parseInt(String(req.body.year), 10)
            : undefined;

    if (month !== undefined && (!Number.isFinite(month) || month < 1 || month > 12)) {
        return res.status(400).json({ message: "month must be 1–12." });
    }
    if (year !== undefined && (!Number.isFinite(year) || year < 2000 || year > 2100)) {
        return res.status(400).json({ message: "year is invalid." });
    }

    const outcome = await executeDefaultBudgetRollover(
        month !== undefined && year !== undefined ? { month, year } : {}
    );
    const httpStatus = outcome.status === "error" ? 500 : 200;
    res.status(httpStatus).json(outcome);
});

export default router;
