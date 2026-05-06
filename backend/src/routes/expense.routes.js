import { Router } from "express";
import { 
    getAllExpenses, 
    getUserExpenses, 
    searchExpensesByUserName,
    addExpense,
    updateExpense,
    deleteExpense,
    downloadMyExpenseReportPdf,
    downloadAdminExpenseReportPdf
} from "../controllers/expense.controllers.js";
import { auth } from "../middlewares/auth.middleware.js";
import { adminOnly } from "../middlewares/admin.middleware.js";

const router = Router();

// Standard Add Expense (Both can use, logic handles standard/extra)
router.route('/').post(auth, addExpense);

// 1. Logged-in User ke apne expenses
router.route('/my-expenses').get(auth, getUserExpenses);

// 2. Admin Only: Saare expenses dekhna
router.route('/all').get(auth, adminOnly, getAllExpenses);

// 3. Admin Only: User Name se search karna
router.route('/search').get(auth, adminOnly, searchExpensesByUserName);

// PDF reports
router.route('/report/pdf').get(auth, downloadMyExpenseReportPdf);
router.route('/report/pdf/all').get(auth, adminOnly, downloadAdminExpenseReportPdf);

// Update / delete (keep after static paths so :id does not capture e.g. "report")
router.route('/:id').put(auth, updateExpense).delete(auth, deleteExpense);

export default router;