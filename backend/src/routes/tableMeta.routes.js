import { Router } from "express";
import { auth } from "../middlewares/auth.middleware.js";
import { adminOnly } from "../middlewares/admin.middleware.js";
import {
    getBudgetTableMeta,
    getExpenseTableMeta,
    getUserTableMeta
} from "../controllers/tableMeta.controllers.js";

const router = Router();

router.get("/tables/users", auth, adminOnly, getUserTableMeta);
router.get("/tables/expenses", auth, getExpenseTableMeta);
router.get("/tables/budgets", auth, adminOnly, getBudgetTableMeta);

export default router;
