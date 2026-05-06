import { pool } from '../db/index.js';
import Tesseract from 'tesseract.js';
import { sendExpenseReportPdf } from '../utils/expenseReportPdf.js';

/** MariaDB driver often returns insertId / INT columns as BigInt; JSON.stringify cannot serialize BigInt */
const jsonNumber = (v) => (typeof v === 'bigint' ? Number(v) : v);

const rowToJson = (row) =>
    Object.fromEntries(
        Object.entries(row).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])
    );

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
 */
export const addExpense = async (req, res) => {
    const { 
        title, category_id, amount, payment_method, 
        vendor, description, expense_date, expense_type 
    } = req.body;
    
    const user_id = req.user.id;
    const user_role = req.user.role; 
    const receipt_path = req.file ? req.file.path : null;
    
    // MariaDB/MySQL Date handling
    const finalDate = expense_date ? new Date(expense_date) : new Date();

    let connection;

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

        if (category_id == null || category_id === '') {
            await connection.rollback();
            return res.status(400).json({ status: "error", message: "category_id is required." });
        }

        const catRaw = await connection.query("SELECT id FROM categories WHERE id = ?", [category_id]);
        const catRows = Array.isArray(catRaw[0]) ? catRaw[0] : catRaw;
        if (!catRows?.length) {
            await connection.rollback();
            return res.status(400).json({
                status: "error",
                message: `Invalid category_id: no row in categories for id=${category_id}. Seed categories or call GET /api/category and use a real id.`
            });
        }

        // 2. Budget Validation (Standard Expenses ke liye)
        if (expense_type !== 'extra') {
            // Check Allocated Budget
            // Note: MariaDB mein [rows] destructuring tabhi kaam karegi jab pool 'mysql2/promise' se bana ho
            const budgetResult = await connection.query(
                `SELECT allocated_amount FROM monthly_budgets 
                 WHERE category_id = ? AND month = MONTH(?) AND year = YEAR(?)`,
                [category_id, finalDate, finalDate]
            );

            // Destructuring fix: Agar result array hai toh pehla element lein
            const budgetRows = Array.isArray(budgetResult[0]) ? budgetResult[0] : budgetResult;

            if (!budgetRows || budgetRows.length === 0) {
                await connection.rollback();
                return res.status(400).json({ 
                    status: "error",
                    message: "Budget record not found! Pehle budget create karein." 
                });
            }

            const allocatedAmount = parseFloat(budgetRows[0].allocated_amount);

            // Calculate current total spent
            const spentResult = await connection.query(
                `SELECT SUM(amount) as total_spent FROM expenses 
                 WHERE category_id = ? AND expense_type = 'standard' 
                 AND MONTH(expense_date) = MONTH(?) AND YEAR(expense_date) = YEAR(?)`,
                [category_id, finalDate, finalDate]
            );

            const spentRows = Array.isArray(spentResult[0]) ? spentResult[0] : spentResult;
            const currentTotalSpent = parseFloat(spentRows[0]?.total_spent || 0);
            const newAmount = parseFloat(amount);

            // 3. Exceed Check
            if (currentTotalSpent + newAmount > allocatedAmount) {
                await connection.rollback();
                return res.status(400).json({ 
                    status: "error",
                    message: "Budget Exceeded!",
                    available: (allocatedAmount - currentTotalSpent).toFixed(2)
                });
            }
        }

        // 4. Record Expense (MariaDB driver returns a single metadata object for INSERT, not [rows, fields])
        const insertResult = await connection.query(
            `INSERT INTO expenses (title, category_id, user_id, amount, payment_method, vendor, receipt_path, description, expense_date, expense_type) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [title, category_id, user_id, amount, payment_method, vendor, receipt_path, description, finalDate, expense_type || 'standard']
        );

        // 5. Commit Transaction
        await connection.commit();

        res.status(201).json({ 
            status: "success", 
            message: "Expense created successfully", 
            expenseId: jsonNumber(insertResult.insertId)
        });

    } catch (error) {
        if (connection) await connection.rollback();
        console.error("MariaDB Error:", error.message);
        res.status(500).json({ error: error.message });
    } finally {
        if (connection) connection.release();
    }
};
// Helper function for reusable pagination & filtering logic
const fetchExpenses = async (whereClauses, queryParams, reqQuery) => {
    const { page = 1, sortBy = 'expense_date', order = 'DESC' } = reqQuery;
    const limit = 8;
    const offset = (page - 1) * limit;

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
    const sortCol = sortBy === 'amount' ? 'e.amount' : 'e.expense_date';

    const dataSql = `
        SELECT e.*, u.name as user_name, c.name as category_name 
        FROM expenses e 
        JOIN users u ON e.user_id = u.id 
        JOIN categories c ON e.category_id = c.id 
        ${whereSql}
        ORDER BY ${sortCol} ${order}, e.id DESC 
        LIMIT ? OFFSET ?
    `;

    const countSql = `SELECT COUNT(*) as total FROM expenses e JOIN users u ON e.user_id = u.id ${whereSql}`;

    const rows = await pool.query(dataSql, [...queryParams, limit, offset]);
    const countRows = await pool.query(countSql, queryParams);
    const total = Number(countRows[0]?.total ?? 0);

    return {
        data: Array.isArray(rows) ? rows.map(rowToJson) : rows,
        pagination: {
            totalItems: total,
            currentPage: parseInt(page),
            totalPages: Math.ceil(total / limit)
        }
    };
};

/**
 * 1. GET ALL EXPENSES (Admin Only)
 * Saare users ka data dikhayega with filtering.
 */
export const getAllExpenses = async (req, res) => {
    try {
        const { category_id } = req.query;
        let whereClauses = [];
        let queryParams = [];

        if (category_id) {
            whereClauses.push("e.category_id = ?");
            queryParams.push(category_id);
        }

        const result = await fetchExpenses(whereClauses, queryParams, req.query);
        res.json({ status: "success", ...result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

/**
 * 2. GET USER EXPENSES (Self Only)
 * Sirf login user apna data dekh payega.
 */
export const getUserExpenses = async (req, res) => {
    try {
        const { category_id } = req.query;
        let whereClauses = ["e.user_id = ?"];
        let queryParams = [req.user.id];

        if (category_id) {
            whereClauses.push("e.category_id = ?");
            queryParams.push(category_id);
        }

        const result = await fetchExpenses(whereClauses, queryParams, req.query);
        res.json({ status: "success", ...result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

/**
 * 3. SEARCH EXPENSES BY USER NAME (Admin Only)
 * Admin kisi particular user ke naam se search kar sakega.
 */
export const  searchExpensesByUserName = async (req, res) => {
    try {
        const { search = '' } = req.query;
        if (!search) return res.status(400).json({ message: "Search query is required" });

        let whereClauses = ["u.name LIKE ?"];
        let queryParams = [`%${search}%`];

        const result = await fetchExpenses(whereClauses, queryParams, req.query);
        res.json({ status: "success", ...result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

/**
 * 3. UPDATE & DELETE — owner or admin; only admin may set type to extra
 */
export const updateExpense = async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid expense id' });

    const { title, amount, category_id, description, expense_type } = req.body;
    if (expense_type === 'extra' && req.user.role !== 'admin') {
        return res.status(403).json({ message: 'Only admin can set expense_type to extra.' });
    }

    try {
        const existing = await pool.query('SELECT user_id FROM expenses WHERE id = ?', [id]);
        const rows = Array.isArray(existing) ? existing : [];
        if (!rows.length) return res.status(404).json({ message: 'Expense not found' });

        const ownerId = jsonNumber(rows[0].user_id);
        if (req.user.role !== 'admin' && ownerId !== jsonNumber(req.user.id)) {
            return res.status(403).json({ message: 'Not allowed to update this expense' });
        }

        const isAdmin = req.user.role === 'admin';
        const typeVal = expense_type || 'standard';
        const sql = isAdmin
            ? `UPDATE expenses SET title = ?, amount = ?, category_id = ?, description = ?, expense_type = ? WHERE id = ?`
            : `UPDATE expenses SET title = ?, amount = ?, category_id = ?, description = ?, expense_type = ? WHERE id = ? AND user_id = ?`;
        const params = isAdmin
            ? [title, amount, category_id, description, typeVal, id]
            : [title, amount, category_id, description, typeVal, id, req.user.id];

        const result = await pool.query(sql, params);
        const affected = typeof result?.affectedRows === 'number' ? result.affectedRows : 0;
        if (affected === 0) return res.status(404).json({ message: 'Expense not found or not updated' });

        res.json({ message: 'Updated successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

export const deleteExpense = async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid expense id' });

    try {
        const existing = await pool.query('SELECT user_id FROM expenses WHERE id = ?', [id]);
        const rows = Array.isArray(existing) ? existing : [];
        if (!rows.length) return res.status(404).json({ message: 'Expense not found' });

        const ownerId = jsonNumber(rows[0].user_id);
        if (req.user.role !== 'admin' && ownerId !== jsonNumber(req.user.id)) {
            return res.status(403).json({ message: 'Not allowed to delete this expense' });
        }

        const isAdmin = req.user.role === 'admin';
        const sql = isAdmin ? 'DELETE FROM expenses WHERE id = ?' : 'DELETE FROM expenses WHERE id = ? AND user_id = ?';
        const params = isAdmin ? [id] : [id, req.user.id];

        const result = await pool.query(sql, params);
        const affected = typeof result?.affectedRows === 'number' ? result.affectedRows : 0;
        if (affected === 0) return res.status(404).json({ message: 'Expense not found' });

        res.json({ message: 'Deleted successfully' });
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

const fetchExpensesForPdf = async (whereSql, params) => {
    const sql = `
        SELECT e.expense_date, e.title, e.amount, e.payment_method, e.expense_type,
               c.name AS category_name, u.name AS user_name
        FROM expenses e
        JOIN categories c ON e.category_id = c.id
        JOIN users u ON e.user_id = u.id
        ${whereSql}
        ORDER BY e.expense_date DESC, e.id DESC
    `;
    const rows = await pool.query(sql, params);
    const list = Array.isArray(rows) ? rows : [];
    return list.map(rowToJson);
};

/**
 * PDF report: logged-in user's expenses only.
 * Query: optional month+year, optional category_id. Omit month/year = all dates.
 */
export const downloadMyExpenseReportPdf = async (req, res) => {
    try {
        const parsed = parseReportFilters(req);
        if (parsed.error) return res.status(400).json({ message: parsed.error });

        let where = 'WHERE e.user_id = ?';
        const params = [req.user.id];
        if (parsed.month != null) {
            where += ' AND MONTH(e.expense_date) = ? AND YEAR(e.expense_date) = ?';
            params.push(parsed.month, parsed.year);
        }
        if (parsed.category_id != null) {
            where += ' AND e.category_id = ?';
            params.push(parsed.category_id);
        }

        const rows = await fetchExpensesForPdf(where, params);
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

        let where = 'WHERE 1=1';
        const params = [];
        if (parsed.month != null) {
            where += ' AND MONTH(e.expense_date) = ? AND YEAR(e.expense_date) = ?';
            params.push(parsed.month, parsed.year);
        }
        if (parsed.category_id != null) {
            where += ' AND e.category_id = ?';
            params.push(parsed.category_id);
        }

        const rows = await fetchExpensesForPdf(where, params);
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