import { Router } from "express";
import { adminOnly } from "../middlewares/admin.middleware.js";
import { auth } from "../middlewares/auth.middleware.js";
import { createCategoryWithBudget, getCategoryWiseBudgets, getTotalBudgetsSummary, toggleUserStatus } from "../controllers/admin.controllers.js";

const router = Router();
router.route('/toggle/:id').patch(auth , adminOnly, toggleUserStatus);
router.route('/CategoryBudget').post(auth , adminOnly , createCategoryWithBudget);
router.route('/total-summary').get(auth , adminOnly,  getTotalBudgetsSummary);
router.route('/budget-details' , auth, adminOnly , getCategoryWiseBudgets)
export default router;