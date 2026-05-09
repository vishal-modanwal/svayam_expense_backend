import { Router } from "express";
import { adminOnly } from "../middlewares/admin.middleware.js";
import { auth } from "../middlewares/auth.middleware.js";
import {
    createCategoryWithBudget,
    deleteBudget,
    getCategoryWiseBudgets,
    getTotalBudgetsSummary,
    getUsersDetails,
    toggleUserStatus,
    updateBudget
} from "../controllers/admin.controllers.js";

const router = Router();
router.route('/toggle/:id').patch(auth , adminOnly, toggleUserStatus);
router.route('/users-details').get(auth, adminOnly, getUsersDetails);
router.route('/CategoryBudget').post(auth , adminOnly , createCategoryWithBudget);
router.route('/total-summary').get(auth , adminOnly,  getTotalBudgetsSummary);
router.route('/budget-details').get(auth, adminOnly, getCategoryWiseBudgets);
/** monthly_budgets row id — from GET /budget-details as budget_id */
router.route('/budget/:id').put(auth, adminOnly, updateBudget).delete(auth, adminOnly, deleteBudget);

export default router;