import { pool } from '../db/index.js';
import Tesseract from 'tesseract.js';
import { sendExpenseReportPdf } from '../utils/expenseReportPdf.js';
import { fireBudget90Alert, fireBudget90AlertAfterUpdate } from '../utils/budgetThresholdAlert.js';
import { selectRowArray, isMissingArchivedColumnError } from '../utils/mariaRows.js';
import { createNotification } from '../utils/notifications.js';
import {
    activeCategoryWhere,
    activeExpenseWhere,
    ARCHIVED_NO,
} from '../utils/categoryArchive.js';
import { isArchivedYes } from '../utils/archiveCategory.js';
import {
    EXPENSE_ARCHIVE_REASON,
    softArchiveExpenseById,
} from '../utils/expenseArchive.js';
import {
    fetchUserMonthlyBudgetRow,
    syncUserBudgetAfterExpenseChange,
    fireUserBudgetSync,
    monthYearFromExpenseDate,
} from '../utils/userMonthlyBudget.js';
import { resolvePeriodFromQuery } from '../utils/periodQuery.js';

/** MariaDB driver often returns insertId / INT columns as BigInt; JSON.stringify cannot serialize BigInt */
const jsonNumber = (v) => (typeof v === 'bigint' ? Number(v) : v);

const rowToJson = (row) =>
    Object.fromEntries(
        Object.entries(row).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])
    );

/** Explicit list — avoids `e.*` + JOIN where `categories.description` overwrites `expenses.description`. */
const EXPENSE_LIST_SELECT = `
  e.id, e.title, e.category_id, e.user_id, e.amount, e.currency,
  e.payment_method, e.vendor, e.receipt_path,
  e.description AS expense_description,
  e.expense_date, e.expense_type, e.created_at`;

/** DB column is `description`; FE often sends/reads `notes`. */
const expenseNotesFromBody = (body) => {
    const v = body?.description ?? body?.notes;
    if (v === undefined || v === null) return null;
    const s = String(v).trim();
    return s === "" ? null : s;
};

const mapExpenseRowWithCategoryMeta = (raw) => {
    const r = rowToJson(raw);
    if (r.expense_description !== undefined) {
        r.description = r.expense_description;
        delete r.expense_description;
    }
    r.notes = r.description ?? null;
    if (Object.prototype.hasOwnProperty.call(r, 'category_archived')) {
        const archived = Number(r.category_archived) === 1 || r.category_archived === true;
        r.category_archived = archived;
        r.category_status = archived ? 'history_only' : 'active';
    }
    return r;
};

/**
 * 1. ADD EXPENSE
 * Logic: User hamesha 'standard' create karega (Budget check hoga).
 * Admin 'extra' create kar sakta hai (Budget bypass hoga).
 */


/**
 * CREATE EXPENSE (Final Version)
 * Features:
 * 1. Transaction-based safety
 * 2. Admin-only 'extra' bypass logic
 * 3. Real-time budget exceed check
 * 4. Safe data extraction (Optional Chaining)
 * 5. Multipart `receipt` is optional and unrelated to POST /scan-receipt: OCR uses a temp file that is deleted; to persist this image on the expense, the client must send `receipt` again on this create request.
 */
export const addExpense = async (req, res) => {
    const {
        title,
        category_id: rawCategoryId,
        amount: rawAmount,
        payment_method,
        vendor,
        expense_date,
        expense_type
    } = req.body;
    const description = expenseNotesFromBody(req.body);

    const category_id =
        rawCategoryId === undefined || rawCategoryId === '' ? rawCategoryId : parseInt(String(rawCategoryId), 10);
    const amount = rawAmount === undefined || rawAmount === '' ? NaN : parseFloat(String(rawAmount));

    const user_id = req.user.id;
    const user_role = req.user.role;
    /** Stored filename only; served at GET /uploads/:filename */
    const receipt_path = req.file ? req.file.filename : null;
    
    // MariaDB/MySQL Date handling
    const finalDate = expense_date ? new Date(expense_date) : new Date();

    let connection;
    /** Set when a standard expense passes budget checks — used after commit for 90% admin email */
    let standardBudgetSnapshot = null;

    try {
        // Pool se connection acquire karein
        connection = await pool.getConnection();
        
        // Transaction Shuru karein
        await connection.beginTransaction();

        // 1. Role-Based Security
        if (expense_type === 'extra' && user_role !== 'admin') {
            await connection.rollback();
            return res.status(403).json({ message: "Unauthorized: Sirf Admin extra expense add kar sakta hai." });
        }

        if (category_id == null || category_id === '' || !Number.isFinite(category_id)) {
            await connection.rollback();
            return res.status(400).json({ status: "error", message: "category_id is required." });
        }

        if (!Number.isFinite(amount) || amount < 0) {
            await connection.rollback();
            return res.status(400).json({ status: "error", message: "amount must be a valid non-negative number." });
        }

        const catRaw = await connection.query(
            `SELECT id FROM categories WHERE id = ? AND archived = ?`,
            [category_id, ARCHIVED_NO]
        );
        const catRows = Array.isArray(catRaw[0]) ? catRaw[0] : catRaw;
        if (!catRows?.length) {
            await connection.rollback();
            return res.status(400).json({
                status: "error",
                message: `Invalid category_id: no row in categories for id=${category_id}. Seed categories or call GET /api/category and use a real id.`
            });
        }

        // 2. Budget validation (standard): category cap OR optional per-user monthly cap
        const typeForBudget = expense_type || 'standard';
        let userBudgetPayload = null;

        if (typeForBudget !== 'extra') {
            const { month: budgetMonth, year: budgetYear } = monthYearFromExpenseDate(finalDate);
            const userBudgetRow =
                budgetMonth != null
                    ? await fetchUserMonthlyBudgetRow(connection, user_id, budgetMonth, budgetYear)
                    : null;
            const hasUserMonthlyBudget = !!userBudgetRow;

            const budgetResult = await connection.query(
                `SELECT allocated_amount, currency FROM monthly_budgets 
                 WHERE category_id = ? AND month = MONTH(?) AND year = YEAR(?) AND archived = ?`,
                [category_id, finalDate, finalDate, ARCHIVED_NO]
            );
            const budgetRows = Array.isArray(budgetResult[0]) ? budgetResult[0] : budgetResult;

            if (!hasUserMonthlyBudget) {
                if (!budgetRows || budgetRows.length === 0) {
                    await connection.rollback();
                    return res.status(400).json({
                        status: "error",
                        message: "Budget record not found! Pehle budget create karein.",
                    });
                }

                const allocatedAmount = parseFloat(budgetRows[0].allocated_amount);
                const budgetCurrency = budgetRows[0].currency || 'INR';

                const spentResult = await connection.query(
                    `SELECT SUM(amount) as total_spent FROM expenses 
                     WHERE category_id = ? AND expense_type = 'standard' AND archived = ?
                     AND MONTH(expense_date) = MONTH(?) AND YEAR(expense_date) = YEAR(?)`,
                    [category_id, ARCHIVED_NO, finalDate, finalDate]
                );
                const spentRows = Array.isArray(spentResult[0]) ? spentResult[0] : spentResult;
                const currentTotalSpent = parseFloat(spentRows[0]?.total_spent || 0);
                const newAmount = parseFloat(amount);

                if (currentTotalSpent + newAmount > allocatedAmount) {
                    await connection.rollback();
                    return res.status(400).json({
                        status: "error",
                        message: "Budget Exceeded!",
                        available: (allocatedAmount - currentTotalSpent).toFixed(2),
                    });
                }

                standardBudgetSnapshot = {
                    categoryId: category_id,
                    expenseDate: finalDate,
                    previousStandardSpentInBucket: currentTotalSpent,
                    newStandardSpentInBucket: currentTotalSpent + newAmount,
                    allocatedAmount,
                    currency: budgetCurrency,
                };
            } else if (budgetRows?.length) {
                const allocatedAmount = parseFloat(budgetRows[0].allocated_amount);
                const budgetCurrency = budgetRows[0].currency || 'INR';
                const spentResult = await connection.query(
                    `SELECT SUM(amount) as total_spent FROM expenses 
                     WHERE category_id = ? AND expense_type = 'standard' AND archived = ?
                     AND MONTH(expense_date) = MONTH(?) AND YEAR(expense_date) = YEAR(?)`,
                    [category_id, ARCHIVED_NO, finalDate, finalDate]
                );
                const spentRows = Array.isArray(spentResult[0]) ? spentResult[0] : spentResult;
                const currentTotalSpent = parseFloat(spentRows[0]?.total_spent || 0);
                const newAmount = parseFloat(amount);
                standardBudgetSnapshot = {
                    categoryId: category_id,
                    expenseDate: finalDate,
                    previousStandardSpentInBucket: currentTotalSpent,
                    newStandardSpentInBucket: currentTotalSpent + newAmount,
                    allocatedAmount,
                    currency: budgetCurrency,
                };
            }
        }

        // 4. Record Expense (MariaDB driver returns a single metadata object for INSERT, not [rows, fields])
        const insertResult = await connection.query(
            `INSERT INTO expenses (title, category_id, user_id, amount, payment_method, vendor, receipt_path, description, expense_date, expense_type) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [title, category_id, user_id, amount, payment_method, vendor, receipt_path, description, finalDate, expense_type || 'standard']
        );

        const userRows = selectRowArray(
            await connection.query("SELECT name FROM users WHERE id = ?", [user_id])
        );
        const catRowsForMsg = selectRowArray(
            await connection.query("SELECT name FROM categories WHERE id = ?", [category_id])
        );
        const user_name = userRows[0]?.name ?? "User";
        const category_name = catRowsForMsg[0]?.name ?? "category";

        const newExpenseId = jsonNumber(insertResult.insertId);
        await createNotification(
            user_id,
            newExpenseId,
            "expense_created",
            `${user_name} added a new expense #${newExpenseId} of ₹${amount} in ${category_name}`,
            connection
        );

        if (typeForBudget !== 'extra') {
            userBudgetPayload = await syncUserBudgetAfterExpenseChange(connection, {
                userId: user_id,
                expenseDate: finalDate,
                expenseType: typeForBudget,
            });
        }

        await connection.commit();

        if (standardBudgetSnapshot) {
            fireBudget90Alert(pool, standardBudgetSnapshot);
        }

        res.status(201).json({ 
            status: "success", 
            message: "Expense created successfully", 
            expenseId: jsonNumber(insertResult.insertId),
            ...(userBudgetPayload || {}),
        });

    } catch (error) {
        if (connection) await connection.rollback();
        console.error("MariaDB Error:", error.message);
        res.status(500).json({ error: error.message });
    } finally {
        if (connection) connection.release();
    }
};
/**
 * Shared list query for expenses.
 * @param {{ mode?: 'my', period?: { month: number, year: number } }} [options]
 */
const fetchExpenses = async (whereClauses, queryParams, reqQuery, options = {}) => {
    const isMy = options.mode === "my";
    const period = options.period;
    const page = Math.max(parseInt(reqQuery.page, 10) || 1, 1);
    const orderRaw = String(reqQuery.order ?? "desc").toLowerCase();
    const orderDir = orderRaw === "asc" ? "ASC" : "DESC";

    let limit;
    let sortCol;
    let sortByEcho;

    const clauses = [...whereClauses];
    const params = [...queryParams];

    if (period) {
        clauses.push("MONTH(e.expense_date) = ?", "YEAR(e.expense_date) = ?");
        params.push(period.month, period.year);
    }

    if (isMy) {
        limit = Math.min(Math.max(parseInt(reqQuery.limit, 10) || 15, 1), 100);
        const sortMap = {
            expense_date: "e.expense_date",
            amount: "e.amount",
            created_at: "e.created_at"
        };
        const sb = String(reqQuery.sortBy || "expense_date").trim();
        sortCol = sortMap[sb] || sortMap.expense_date;
        sortByEcho = Object.keys(sortMap).includes(sb) ? sb : "expense_date";

        const search = String(reqQuery.search ?? "").trim();
        if (search) {
            clauses.push("(e.title LIKE ? OR e.vendor LIKE ?)");
            params.push(`%${search}%`, `%${search}%`);
        }
    } else {
        limit = 8;
        const sortBy = reqQuery.sortBy === "amount" ? "amount" : "expense_date";
        sortCol = sortBy === "amount" ? "e.amount" : "e.expense_date";
        sortByEcho = sortBy;
    }

    const offset = (page - 1) * limit;

    const buildDataSql = (useArchiveFilter, activeClauses, activeParams) => {
        const allClauses = [...activeClauses];
        const allParams = [...activeParams];
        if (useArchiveFilter) {
            allClauses.push(activeCategoryWhere("c"), activeExpenseWhere("e"));
        }
        const whereSql = allClauses.length > 0 ? `WHERE ${allClauses.join(" AND ")}` : "";
        return {
            whereSql,
            sql: `
        SELECT ${EXPENSE_LIST_SELECT}, u.name as user_name, c.name as category_name
        FROM expenses e
        JOIN users u ON e.user_id = u.id
        JOIN categories c ON e.category_id = c.id
        ${whereSql}
        ORDER BY ${sortCol} ${orderDir}, e.id DESC
        LIMIT ? OFFSET ?
    `,
            params: allParams,
        };
    };

    const buildCountSql = (useArchiveFilter, activeClauses, activeParams) => {
        const allClauses = [...activeClauses];
        const allParams = [...activeParams];
        if (useArchiveFilter) {
            allClauses.push(activeCategoryWhere("c"), activeExpenseWhere("e"));
        }
        const whereSql = allClauses.length > 0 ? `WHERE ${allClauses.join(" AND ")}` : "";
        return {
            whereSql,
            sql: `SELECT COUNT(*) as total FROM expenses e
        JOIN users u ON e.user_id = u.id
        JOIN categories c ON e.category_id = c.id
        ${whereSql}`,
            params: allParams,
        };
    };

    const runQuery = async (useArchiveFilter) => {
        const data = buildDataSql(useArchiveFilter, clauses, params);
        const count = buildCountSql(useArchiveFilter, clauses, params);
        const rawRows = await pool.query(data.sql, [...data.params, limit, offset]);
        const rawCount = await pool.query(count.sql, count.params);
        return {
            rows: selectRowArray(rawRows),
            countRows: selectRowArray(rawCount),
        };
    };

    let rows;
    let countRows;
    try {
        ({ rows, countRows } = await runQuery(true));
    } catch (e) {
        if (isMissingArchivedColumnError(e)) {
            const err = new Error("Run Schema.sql archived upgrade, then retry.");
            err.code = "SCHEMA_MISSING_archived";
            err.status = 503;
            throw err;
        }
        throw e;
    }

    const total = Number(jsonNumber(countRows[0]?.total ?? 0));

    const basePagination = {
        totalItems: total,
        currentPage: page,
        totalPages: Math.ceil(total / limit) || 0
    };

    const result = {
        scope: "active",
        ...(period ? { period: { month: period.month, year: period.year } } : {}),
        data: rows.map((row) => {
            const r = mapExpenseRowWithCategoryMeta(row);
            r.category_status = "active";
            r.category_archived = false;
            return r;
        }),
        pagination: isMy ? { ...basePagination, limit } : basePagination
    };

    if (isMy) {
        result.sorting = {
            sort_by: sortByEcho,
            order: orderDir.toLowerCase()
        };
    }

    return result;
};

/**
 * 1. GET ALL EXPENSES (Admin Only)
 * Saare users ka data dikhayega with filtering.
 */
export const getAllExpenses = async (req, res) => {
    try {
        const period = resolvePeriodFromQuery(req.query);
        if (period.error) {
            return res.status(400).json({ message: period.error });
        }

        const { category_id } = req.query;
        let whereClauses = [];
        let queryParams = [];

        if (category_id) {
            whereClauses.push("e.category_id = ?");
            queryParams.push(category_id);
        }

        const result = await fetchExpenses(whereClauses, queryParams, req.query, {
            period,
        });
        res.json({ status: "success", ...result });
    } catch (error) {
        const status = error.status || 500;
        res.status(status).json(
            error.code ? { message: error.message, code: error.code } : { error: error.message }
        );
    }
};

/**
 * 2. GET USER EXPENSES (Self Only)
 * Sirf login user apna data. Pagination: page (default 1), limit (default 15, max 100).
 * Latest first: sortBy=expense_date (default) + order=desc (default).
 * sortBy: expense_date | amount | created_at. order: asc | desc.
 * search: optional — matches title OR vendor (substring, LIKE).
 * Optional category_id filter (unchanged).
 */
export const getUserExpenses = async (req, res) => {
    try {
        const period = resolvePeriodFromQuery(req.query);
        if (period.error) {
            return res.status(400).json({ message: period.error });
        }

        const { category_id } = req.query;
        const uid = jsonNumber(req.user.id);
        if (!Number.isFinite(uid)) {
            return res.status(401).json({ message: 'Invalid user session' });
        }
        let whereClauses = ["e.user_id = ?"];
        let queryParams = [uid];

        if (category_id) {
            whereClauses.push("e.category_id = ?");
            queryParams.push(category_id);
        }

        const result = await fetchExpenses(whereClauses, queryParams, req.query, {
            mode: "my",
            period,
        });
        res.json({ status: "success", ...result });
    } catch (error) {
        const status = error.status || 500;
        res.status(status).json(
            error.code ? { message: error.message, code: error.code } : { error: error.message }
        );
    }
};

/**
 * 3. SEARCH EXPENSES BY USER NAME (Admin Only)
 * Admin kisi particular user ke naam se search kar sakega.
 */
export const  searchExpensesByUserName = async (req, res) => {
    try {
        const period = resolvePeriodFromQuery(req.query);
        if (period.error) {
            return res.status(400).json({ message: period.error });
        }

        const { search = '' } = req.query;
        if (!search) return res.status(400).json({ message: "Search query is required" });

        let whereClauses = ["u.name LIKE ?"];
        let queryParams = [`%${search}%`];

        const result = await fetchExpenses(whereClauses, queryParams, req.query, {
            period,
        });
        res.json({ status: "success", ...result });
    } catch (error) {
        const status = error.status || 500;
        res.status(status).json(
            error.code ? { message: error.message, code: error.code } : { error: error.message }
        );
    }
};

/**
 * 3. UPDATE & DELETE — owner or admin; only admin may set type to extra.
 * Multipart PUT with `receipt` replaces stored file; scan-receipt does not feed this route automatically.
 */
export const updateExpense = async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid expense id' });

    const {
        title,
        amount: rawAmount,
        category_id: rawCategoryId,
        expense_type,
        payment_method,
        vendor
    } = req.body;
    const description = expenseNotesFromBody(req.body);

    const category_id =
        rawCategoryId === undefined || rawCategoryId === ''
            ? NaN
            : parseInt(String(rawCategoryId), 10);
    const amount = rawAmount === undefined || rawAmount === '' ? NaN : parseFloat(String(rawAmount));

    if (expense_type === 'extra' && req.user.role !== 'admin') {
        return res.status(403).json({ message: 'Only admin can set expense_type to extra.' });
    }

    if (!Number.isFinite(category_id) || !Number.isFinite(amount) || amount < 0) {
        return res.status(400).json({ message: 'amount and category_id must be valid numbers.' });
    }

    try {
        const existing = await pool.query(
            'SELECT user_id, amount, category_id, expense_type, expense_date FROM expenses WHERE id = ?',
            [id]
        );
        const rawExisting = Array.isArray(existing) ? existing : [];
        const rows = Array.isArray(rawExisting[0]) ? rawExisting[0] : rawExisting;
        if (!rows.length) return res.status(404).json({ message: 'Expense not found' });

        const existingRow = rowToJson(rows[0]);
        const ownerId = jsonNumber(existingRow.user_id);
        if (req.user.role !== 'admin' && ownerId !== jsonNumber(req.user.id)) {
            return res.status(403).json({ message: 'Not allowed to update this expense' });
        }

        const expMeta = selectRowArray(
            await pool.query('SELECT archived FROM expenses WHERE id = ?', [id])
        );
        if (expMeta.length && isArchivedYes(expMeta[0].archived)) {
            return res.status(400).json({
                message: 'Cannot update an archived expense (history only).',
                category_status: 'history_only',
            });
        }

        const prevCat = jsonNumber(existingRow.category_id);
        if (category_id !== prevCat) {
            const catList = selectRowArray(
                await pool.query(
                    'SELECT id FROM categories WHERE id = ? AND archived = ?',
                    [category_id, ARCHIVED_NO]
                )
            );
            if (!catList.length) {
                return res.status(400).json({ status: 'error', message: 'Invalid or archived category_id.' });
            }
        }

        const isAdmin = req.user.role === 'admin';
        const typeVal = expense_type || 'standard';
        const newReceipt = req.file ? req.file.filename : null;

        let sql;
        let params;
        if (newReceipt) {
            sql = isAdmin
                ? `UPDATE expenses SET title = ?, amount = ?, category_id = ?, description = ?, expense_type = ?, receipt_path = ?, payment_method = COALESCE(?, payment_method), vendor = COALESCE(?, vendor) WHERE id = ?`
                : `UPDATE expenses SET title = ?, amount = ?, category_id = ?, description = ?, expense_type = ?, receipt_path = ?, payment_method = COALESCE(?, payment_method), vendor = COALESCE(?, vendor) WHERE id = ? AND user_id = ?`;
            params = isAdmin
                ? [title, amount, category_id, description, typeVal, newReceipt, payment_method ?? null, vendor ?? null, id]
                : [title, amount, category_id, description, typeVal, newReceipt, payment_method ?? null, vendor ?? null, id, req.user.id];
        } else {
            sql = isAdmin
                ? `UPDATE expenses SET title = ?, amount = ?, category_id = ?, description = ?, expense_type = ?, payment_method = COALESCE(?, payment_method), vendor = COALESCE(?, vendor) WHERE id = ?`
                : `UPDATE expenses SET title = ?, amount = ?, category_id = ?, description = ?, expense_type = ?, payment_method = COALESCE(?, payment_method), vendor = COALESCE(?, vendor) WHERE id = ? AND user_id = ?`;
            params = isAdmin
                ? [title, amount, category_id, description, typeVal, payment_method ?? null, vendor ?? null, id]
                : [title, amount, category_id, description, typeVal, payment_method ?? null, vendor ?? null, id, req.user.id];
        }

        const actorLabel = req.user.name || req.user.email || `User #${jsonNumber(req.user.id)}`;

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            const result = await conn.query(sql, params);
            const affected = typeof result?.affectedRows === 'number' ? result.affectedRows : 0;
            if (affected === 0) {
                await conn.rollback();
                return res.status(404).json({ message: 'Expense not found or not updated' });
            }

            const catRowsForMsg = selectRowArray(
                await conn.query('SELECT name FROM categories WHERE id = ?', [category_id])
            );
            const category_name = catRowsForMsg[0]?.name ?? 'category';
            await createNotification(
                ownerId,
                id,
                'expense_updated',
                `${actorLabel} updated expense #${id} of ₹${amount} in ${category_name}`,
                conn
            );
            await conn.commit();
        } catch (e) {
            await conn.rollback();
            throw e;
        } finally {
            conn.release();
        }

        fireBudget90AlertAfterUpdate(existingRow, {
            amount,
            category_id,
            expense_type: typeVal
        });

        fireUserBudgetSync(pool, {
            userId: ownerId,
            expenseDate: existingRow.expense_date,
            expenseType: typeVal,
        });

        res.json({ message: 'Updated successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

export const deleteExpense = async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid expense id' });

    const permanent =
        req.query.permanent === 'true' ||
        req.query.permanent === '1' ||
        req.query.hard === 'true' ||
        req.query.hard === '1';

    try {
        const existingRaw = await pool.query(
            'SELECT user_id, title, archived, amount, category_id, expense_date, expense_type FROM expenses WHERE id = ?',
            [id]
        );
        const rows = selectRowArray(existingRaw);
        if (!rows.length) return res.status(404).json({ message: 'Expense not found' });

        const isAdmin = req.user.role === 'admin';
        const alreadyArchived = isArchivedYes(rows[0].archived);

        if (permanent && !isAdmin) {
            return res.status(403).json({ message: 'Only admin can permanently delete an expense.' });
        }
        if (!permanent && alreadyArchived) {
            return res.status(400).json({ message: 'Expense is already archived (history only).' });
        }

        const ownerId = jsonNumber(rows[0].user_id);
        const deletedAmount = parseFloat(String(rows[0].amount ?? ''));
        const deletedCategoryId = jsonNumber(rows[0].category_id);
        if (!isAdmin && ownerId !== jsonNumber(req.user.id)) {
            return res.status(403).json({ message: 'Not allowed to delete this expense' });
        }

        const actorId = jsonNumber(req.user.id);
        const actorLabel = req.user.name || req.user.email || `User #${actorId}`;
        const archiveReason = isAdmin
            ? EXPENSE_ARCHIVE_REASON.ADMIN_DELETED
            : EXPENSE_ARCHIVE_REASON.USER_DELETED;

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            const catRowsForMsg = selectRowArray(
                await conn.query('SELECT name FROM categories WHERE id = ?', [deletedCategoryId])
            );
            const category_name = catRowsForMsg[0]?.name ?? 'category';

            if (permanent) {
                const sql = isAdmin
                    ? 'DELETE FROM expenses WHERE id = ?'
                    : 'DELETE FROM expenses WHERE id = ? AND user_id = ?';
                const params = isAdmin ? [id] : [id, req.user.id];
                const result = await conn.query(sql, params);
                const affected = typeof result?.affectedRows === 'number' ? result.affectedRows : 0;
                if (affected === 0) {
                    await conn.rollback();
                    return res.status(404).json({ message: 'Expense not found' });
                }
                await createNotification(
                    ownerId,
                    null,
                    'expense_deleted',
                    `${actorLabel} permanently deleted expense #${id} of ₹${deletedAmount} in ${category_name}`,
                    conn
                );
            } else {
                const affected = await softArchiveExpenseById(conn, id, archiveReason, actorId);
                if (affected === 0) {
                    await conn.rollback();
                    return res.status(404).json({ message: 'Expense not found or already archived' });
                }
                await createNotification(
                    ownerId,
                    id,
                    'expense_deleted',
                    `${actorLabel} deleted expense #${id} of ₹${deletedAmount} in ${category_name}`,
                    conn
                );
            }

            await conn.commit();
        } catch (e) {
            await conn.rollback();
            throw e;
        } finally {
            conn.release();
        }

        fireUserBudgetSync(pool, {
            userId: ownerId,
            expenseDate: rows[0].expense_date,
            expenseType: rows[0].expense_type || 'standard',
        });

        res.json({
            message: permanent ? 'Permanently deleted successfully' : 'Expense archived successfully',
            permanent,
            archived: !permanent,
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

const parseReportFilters = (req) => {
    const { month, year, category_id } = req.query;
    const m = month !== undefined && month !== '' ? parseInt(month, 10) : null;
    const y = year !== undefined && year !== '' ? parseInt(year, 10) : null;
    if ((m == null) !== (y == null)) {
        return { error: 'Provide both month and year, or omit both for all periods.' };
    }
    if (m != null) {
        if (!Number.isFinite(m) || m < 1 || m > 12) return { error: 'month must be 1–12' };
        if (!Number.isFinite(y) || y < 2000 || y > 2100) return { error: 'year must be a valid year' };
    }
    const cat = category_id !== undefined && category_id !== '' ? parseInt(category_id, 10) : null;
    if (cat != null && !Number.isFinite(cat)) return { error: 'category_id invalid' };
    return { month: m, year: y, category_id: cat };
};

const fetchExpensesForPdf = async (whereBody, params) => {
    const sql = `
        SELECT e.expense_date, e.title, e.amount, e.payment_method, e.expense_type,
               e.description AS expense_description,
               c.name AS category_name, u.name AS user_name
        FROM expenses e
        JOIN categories c ON e.category_id = c.id
        JOIN users u ON e.user_id = u.id
        WHERE ${whereBody} AND ${activeCategoryWhere("c")} AND ${activeExpenseWhere("e")}
        ORDER BY e.expense_date DESC, e.id DESC
    `;
    const rows = selectRowArray(await pool.query(sql, params));
    return rows.map((row) => {
        const r = mapExpenseRowWithCategoryMeta(row);
        r.category_status = "active";
        r.category_archived = false;
        return r;
    });
};

/**
 * PDF report: logged-in user's expenses only.
 * Query: optional month+year, optional category_id. Omit month/year = all dates.
 */
export const downloadMyExpenseReportPdf = async (req, res) => {
    try {
        const parsed = parseReportFilters(req);
        if (parsed.error) return res.status(400).json({ message: parsed.error });

        const whereParts = ['e.user_id = ?'];
        const params = [req.user.id];
        if (parsed.month != null) {
            whereParts.push('MONTH(e.expense_date) = ?', 'YEAR(e.expense_date) = ?');
            params.push(parsed.month, parsed.year);
        }
        if (parsed.category_id != null) {
            whereParts.push('e.category_id = ?');
            params.push(parsed.category_id);
        }

        const rows = await fetchExpensesForPdf(whereParts.join(' AND '), params);
        const period =
            parsed.month != null
                ? `Period: ${parsed.year}-${String(parsed.month).padStart(2, '0')}`
                : 'Period: all dates';
        const label = req.user.name || req.user.email || `User #${req.user.id}`;
        sendExpenseReportPdf(res, {
            reportTitle: 'Svayam — My expense report',
            subtitleLines: [label, period],
            rows,
            includeUserColumn: false
        });
    } catch (error) {
        if (!res.headersSent) res.status(500).json({ error: error.message });
    }
};

/**
 * PDF report: all users (admin). Same filters.
 */
export const downloadAdminExpenseReportPdf = async (req, res) => {
    try {
        const parsed = parseReportFilters(req);
        if (parsed.error) return res.status(400).json({ message: parsed.error });

        const whereParts = ['1=1'];
        const params = [];
        if (parsed.month != null) {
            whereParts.push('MONTH(e.expense_date) = ?', 'YEAR(e.expense_date) = ?');
            params.push(parsed.month, parsed.year);
        }
        if (parsed.category_id != null) {
            whereParts.push('e.category_id = ?');
            params.push(parsed.category_id);
        }

        const rows = await fetchExpensesForPdf(whereParts.join(' AND '), params);
        const period =
            parsed.month != null
                ? `Period: ${parsed.year}-${String(parsed.month).padStart(2, '0')}`
                : 'Period: all dates';
        const by = req.user.name || req.user.email || `Admin #${req.user.id}`;
        sendExpenseReportPdf(res, {
            reportTitle: 'Svayam — Organization expense report',
            subtitleLines: ['Scope: all users', period, `Exported by: ${by}`],
            rows,
            includeUserColumn: true
        });
    } catch (error) {
        if (!res.headersSent) res.status(500).json({ error: error.message });
    }
};