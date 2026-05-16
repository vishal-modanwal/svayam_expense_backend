import { Router } from "express";
import { adminOnly } from "../middlewares/admin.middleware.js";
import { auth } from "../middlewares/auth.middleware.js";
import {
    createCategoryWithBudget,
    deleteBudget,
    getDashboardExpensesByView,
    getCategoryWiseBudgets,
    getTotalBudgetsSummary,
    getUsersDetails,
    toggleUserStatus,
    updateBudget
} from "../controllers/admin.controllers.js";
import {
    getNotifications,
    getUnreadNotificationCount,
    markAllNotificationsRead
} from "../controllers/notification.controller.js";
import {
    getArchivedBudgets,
    getArchivedCategories,
    getArchivedExpenses
} from "../controllers/archived.controllers.js";

const router = Router();
router.route("/archived/categories").get(auth, adminOnly, getArchivedCategories);
router.route("/archived/expenses").get(auth, adminOnly, getArchivedExpenses);
router.route("/archived/budgets").get(auth, adminOnly, getArchivedBudgets);
router.route('/notifications/unread-count').get(auth, adminOnly, getUnreadNotificationCount);
router.route('/notifications/read-all').patch(auth, adminOnly, markAllNotificationsRead);
router.route('/notifications').get(auth, adminOnly, getNotifications);
router.route('/toggle/:id').patch(auth , adminOnly, toggleUserStatus);
router.route('/users-details').get(auth, adminOnly, getUsersDetails);
router.route('/CategoryBudget').post(auth , adminOnly , createCategoryWithBudget);
/** Same as PUT/PATCH /budget/:id — monthly_budgets.id (budget_id from budget-details). */
router.route('/CategoryBudget/:id')
    .put(auth, adminOnly, updateBudget)
    .patch(auth, adminOnly, updateBudget)
    .delete(auth, adminOnly, deleteBudget);
router.route('/total-summary').get(auth , adminOnly,  getTotalBudgetsSummary);
router.route('/dashboard-expenses').get(auth, adminOnly, getDashboardExpensesByView);
router.route('/budget-details').get(auth, adminOnly, getCategoryWiseBudgets);
/** monthly_budgets row id — from GET /budget-details as budget_id */
router.route('/budget/:id')
    .put(auth, adminOnly, updateBudget)
    .patch(auth, adminOnly, updateBudget)
    .delete(auth, adminOnly, deleteBudget);

export default router;