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
import { getMyArchivedExpenses } from "../controllers/archived.controllers.js";
import { scanReceiptForForm } from "../controllers/receiptScan.controller.js";
import { auth } from "../middlewares/auth.middleware.js";
import { adminOnly } from "../middlewares/admin.middleware.js";
import { optionalReceiptUpload, parseReceiptScanUpload } from "../middlewares/upload.middleware.js";

const router = Router();

/**
 * Receipt scan vs save (API contract):
 * - POST /scan-receipt: multipart field `receipt` only. Server reads the image for OCR, returns JSON hints, then deletes the temp file. No expense row, no persisted receipt, no scan “session id” tying a later create to this upload.
 * - POST / (create) and PUT /:id (update): separate requests. To store a receipt on the expense, send multipart again with `receipt` plus the expense fields. The same image used for scan is NOT reused automatically — the client must attach that file again on save if they want it stored.
 */
router.route('/scan-receipt').post(auth, parseReceiptScanUpload, scanReceiptForForm);

router.route('/').post(auth, optionalReceiptUpload, addExpense);

// 1. Logged-in User ke apne expenses
router.route('/my-expenses/archived').get(auth, getMyArchivedExpenses);
router.route('/my-expenses').get(auth, getUserExpenses);

// 2. Admin Only: Saare expenses dekhna
router.route('/all').get(auth, adminOnly, getAllExpenses);

// 3. Admin Only: User Name se search karna
router.route('/search').get(auth, adminOnly, searchExpensesByUserName);

// PDF reports
router.route('/report/pdf').get(auth, downloadMyExpenseReportPdf);
router.route('/report/pdf/all').get(auth, adminOnly, downloadAdminExpenseReportPdf);

// Update / delete (keep after static paths so :id does not capture e.g. "report")
router.route('/:id').put(auth, optionalReceiptUpload, updateExpense).delete(auth, deleteExpense);

export default router;