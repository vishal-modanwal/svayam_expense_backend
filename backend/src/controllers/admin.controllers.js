import { pool } from "../db/index.js";

/**
 * TOGGLE USER ACTIVE STATUS (Admin Only)
 * Purpose: Enable or disable a user account.
 */
export const toggleUserStatus = async (req, res) => {
    const { id } = req.params; // Jis user ka status badalna hai

    try {
        // SQL logic: is_active = NOT is_active status ko flip kar deta hai
        const result = await pool.query(
            "UPDATE users SET is_active = NOT is_active WHERE id = ?",
            [id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: "User not found" });
        }

        // Updated status fetch karein confirmation ke liye
        const updatedUser = await pool.query(
            "SELECT id, name, is_active FROM users WHERE id = ?",
            [id]
        );

        res.json({ 
            message: `User status updated successfully.`,
            user: updatedUser[0]
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};


/**
 * CREATE CATEGORY AND SET BUDGET (Atomic Flow)
 */
export const createCategoryWithBudget = async (req, res) => {
    const { name, description, month, year, allocated_amount, currency } = req.body;
    const admin_id = req.user.id;

    // Past date constraint
    const currentDate = new Date();
    const currentMonth = currentDate.getMonth() + 1;
    const currentYear = currentDate.getFullYear();

    if (year < currentYear || (year === currentYear && month < currentMonth)) {
        return res.status(400).json({ message: "Past months are not allowed for budgeting." });
    }

    let connection;
    try {
        // Transaction 
        connection = await pool.getConnection();
        await connection.beginTransaction();

        // Step 1: Create Category
        const catResult = await connection.query(
            "INSERT INTO categories (name, description) VALUES (?, ?)",
            [name, description]
        );
        const result = Array.isArray(catResult) ? catResult[0] : catResult;
        const category_id = result.insertId;

        // Step 2: Set Monthly Budget for this new category
        await connection.query(
            `INSERT INTO monthly_budgets (category_id, month, year, allocated_amount, currency, created_by)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [category_id, month, year, allocated_amount, currency || 'INR', admin_id]
        );

        // Sab sahi raha toh commit karein
        await connection.commit();

        res.status(201).json({
            message: "Category and Budget created successfully!",
            data: { category_id : category_id.toString(), name, month, year, allocated_amount }
        });

    } catch (error) {
        if (connection) await connection.rollback(); // Error aane par rollback karein
        
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ message: "This category already exists." });
        }
        res.status(500).json({ error: error.message });
    } finally {
        if (connection) connection.release();
    }
};

/**
 * GET TOTAL BUDGET SUMMARY (dashboard cards — current calendar month/year)
 * Four cards: Budget, Expenses, Remaining, Extra — each with amount + transaction_count.
 */
const num = (v) => (typeof v === 'bigint' ? Number(v) : Number(v || 0));

export const getTotalBudgetsSummary = async (req, res) => {
    try {
        const sql = `
            SELECT
                (SELECT COALESCE(SUM(allocated_amount), 0) FROM monthly_budgets
                 WHERE month = MONTH(CURRENT_DATE()) AND year = YEAR(CURRENT_DATE())) AS total_allocated,
                (SELECT COUNT(*) FROM monthly_budgets
                 WHERE month = MONTH(CURRENT_DATE()) AND year = YEAR(CURRENT_DATE())) AS budget_category_count,

                (SELECT COALESCE(SUM(amount), 0) FROM expenses
                 WHERE MONTH(expense_date) = MONTH(CURRENT_DATE())
                 AND YEAR(expense_date) = YEAR(CURRENT_DATE())) AS total_spent,
                (SELECT COUNT(*) FROM expenses
                 WHERE MONTH(expense_date) = MONTH(CURRENT_DATE())
                 AND YEAR(expense_date) = YEAR(CURRENT_DATE())) AS expense_record_count,

                (SELECT COALESCE(SUM(amount), 0) FROM expenses
                 WHERE expense_type = 'extra'
                 AND MONTH(expense_date) = MONTH(CURRENT_DATE())
                 AND YEAR(expense_date) = YEAR(CURRENT_DATE())) AS extra_total_spent,
                (SELECT COUNT(*) FROM expenses
                 WHERE expense_type = 'extra'
                 AND MONTH(expense_date) = MONTH(CURRENT_DATE())
                 AND YEAR(expense_date) = YEAR(CURRENT_DATE())) AS extra_transaction_count,

                (SELECT COUNT(*) FROM (
                    SELECT
                        (b.allocated_amount - COALESCE(SUM(CASE WHEN e.expense_type = 'standard' THEN e.amount ELSE 0 END), 0)) AS rem
                    FROM monthly_budgets b
                    LEFT JOIN expenses e ON e.category_id = b.category_id
                        AND MONTH(e.expense_date) = b.month
                        AND YEAR(e.expense_date) = b.year
                    WHERE b.month = MONTH(CURRENT_DATE()) AND b.year = YEAR(CURRENT_DATE())
                    GROUP BY b.id, b.allocated_amount
                    HAVING rem > 0
                ) t) AS categories_with_remaining_count,

                (SELECT COUNT(*) FROM expenses
                 WHERE expense_type = 'standard'
                 AND MONTH(expense_date) = MONTH(CURRENT_DATE())
                 AND YEAR(expense_date) = YEAR(CURRENT_DATE())) AS standard_transaction_count
        `;

        const result = await pool.query(sql);
        const data = result[0] || {};

        const allocated = num(data.total_allocated);
        const spent = Number(num(data.total_spent));
        const extraSpent = Number(num(data.extra_total_spent));
        const remaining = allocated - spent;

        const budgetCategoryCount = num(data.budget_category_count);
        const expenseRecordCount = num(data.expense_record_count);
        const extraTx = num(data.extra_transaction_count);
        const categoriesWithRemaining = num(data.categories_with_remaining_count);
        const stdTx = num(data.standard_transaction_count);

        const month = new Date().getMonth() + 1;
        const year = new Date().getFullYear();

        const cards = {
            budget: {
                id: "budget",
                label: "Budget",
                amount: allocated,
                transaction_count: budgetCategoryCount,
                transaction_label: "Budget categories (this month)"
            },
            expenses: {
                id: "expenses",
                label: "Expenses",
                amount: spent,
                transaction_count: expenseRecordCount,
                transaction_label: "Expense records (this month)"
            },
            remaining: {
                id: "remaining",
                label: "Remaining",
                amount: remaining,
                transaction_count: categoriesWithRemaining,
                transaction_label: "Categories with available budget"
            },
            extra: {
                id: "extra",
                label: "Extra expenses",
                amount: extraSpent,
                transaction_count: extraTx,
                transaction_label: "Extra-type transactions"
            }
        };

        const summary = {
            total_allocated: allocated,
            total_spent: spent,
            remaining_total: remaining,
            extra_total_spent: extraSpent,
            overall_usage_hike: allocated ? ((spent / allocated) * 100).toFixed(2) : "0.00",
            standard_transaction_count: stdTx,
            extra_transaction_count: extraTx,
            budget_category_count: budgetCategoryCount,
            expense_record_count: expenseRecordCount,
            categories_with_available_budget: categoriesWithRemaining
        };

        res.json({
            status: "success",
            month,
            year,
            cards,
            summary
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

/**
 * GET ALL USERS DETAILS (Admin Only)
 * Returns user profile fields + expense aggregates.
 */
export const getUsersDetails = async (req, res) => {
    try {
        const { search = "", is_active, sortBy = "created_at", order = "desc" } = req.query;
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 100);
        const offset = (page - 1) * limit;

        const where = [];
        const params = [];

        if (search && String(search).trim() !== "") {
            where.push("(u.name LIKE ? OR u.email LIKE ? OR u.mobile_no LIKE ?)");
            const q = `%${String(search).trim()}%`;
            params.push(q, q, q);
        }

        if (is_active !== undefined) {
            const activeVal = String(is_active).toLowerCase();
            if (activeVal === "1" || activeVal === "true") {
                where.push("u.is_active = 1");
            } else if (activeVal === "0" || activeVal === "false") {
                where.push("u.is_active = 0");
            } else {
                return res.status(400).json({ message: "is_active must be 1/0 or true/false" });
            }
        }

        const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
        const sortable = {
            created_at: "u.created_at",
            name: "u.name",
            email: "u.email",
            mobile_no: "u.mobile_no",
            total_expenses: "total_expenses",
            expense_record_count: "expense_record_count",
            is_active: "u.is_active"
        };
        const orderBy = sortable[String(sortBy)] || sortable.created_at;
        const orderDir = String(order).toLowerCase() === "asc" ? "ASC" : "DESC";

        const sql = `
            SELECT
                u.id,
                u.name,
                u.email,
                u.mobile_no,
                u.is_active,
                COALESCE(SUM(e.amount), 0) AS total_expenses,
                COUNT(e.id) AS expense_record_count
            FROM users u
            LEFT JOIN expenses e ON e.user_id = u.id
            ${whereSql}
            GROUP BY u.id, u.name, u.email, u.mobile_no, u.is_active, u.created_at
            ORDER BY ${orderBy} ${orderDir}, u.id DESC
            LIMIT ? OFFSET ?
        `;

        const rows = await pool.query(sql, [...params, limit, offset]);
        const list = Array.isArray(rows) ? rows : [];
        const data = list.map((row) => ({
            id: num(row.id),
            name: row.name,
            email: row.email,
            mobile_no: row.mobile_no,
            is_active: Boolean(num(row.is_active)),
            activity_status: num(row.is_active) === 1 ? "active" : "inactive",
            total_expenses: Number(row.total_expenses),
            expense_record_count: num(row.expense_record_count)
        }));

        const countSql = `
            SELECT COUNT(*) AS total_users
            FROM users u
            ${whereSql}
        `;
        const countRows = await pool.query(countSql, params);
        const totalUsers = num(countRows?.[0]?.total_users);
        const columns = [
            { key: "id", label: "User ID" },
            { key: "name", label: "Name" },
            { key: "email", label: "Email" },
            { key: "mobile_no", label: "Mobile Number" },
            { key: "is_active", label: "Is Active" },
            { key: "activity_status", label: "Activity Status" },
            { key: "total_expenses", label: "Total Expenses" },
            { key: "expense_record_count", label: "Expense Records" }
        ];

        res.json({
            status: "success",
            total_users: totalUsers,
            column_count: columns.length,
            columns,
            pagination: {
                page,
                limit,
                total_pages: Math.ceil(totalUsers / limit)
            },
            sorting: {
                sort_by: Object.keys(sortable).includes(String(sortBy)) ? String(sortBy) : "created_at",
                order: orderDir.toLowerCase()
            },
            data
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};


/**
 * GET BUDGET DETAILS (category-wise, schema-aligned)
 * - Per monthly_budgets row: category name, allocated amount, spent (standard only), remaining.
 * - Optional query: month (1–12), year (defaults to current calendar month/year).
 * - Use returned budget_id for PUT/DELETE /api/admin/budget/:id
 */
export const getCategoryWiseBudgets = async (req, res) => {
    try {
        const now = new Date();
        let month = parseInt(req.query.month, 10);
        let year = parseInt(req.query.year, 10);
        if (!Number.isFinite(month) || month < 1 || month > 12) {
            month = now.getMonth() + 1;
        }
        if (!Number.isFinite(year) || year < 2000 || year > 2100) {
            year = now.getFullYear();
        }

        const sql = `
            SELECT 
                b.id AS budget_id,
                b.category_id,
                c.name AS category_name,
                b.month,
                b.year,
                b.allocated_amount,
                b.currency,
                COALESCE(SUM(CASE WHEN e.expense_type = 'standard' THEN e.amount ELSE 0 END), 0) AS total_spent,
                (b.allocated_amount - COALESCE(SUM(CASE WHEN e.expense_type = 'standard' THEN e.amount ELSE 0 END), 0)) AS remaining_amount,
                CASE 
                    WHEN b.allocated_amount > 0 
                    THEN ROUND((COALESCE(SUM(CASE WHEN e.expense_type = 'standard' THEN e.amount ELSE 0 END), 0) / b.allocated_amount) * 100, 2)
                    ELSE 0 
                END AS usage_percentage,
                COUNT(CASE WHEN e.expense_type = 'standard' THEN 1 END) AS standard_transaction_count,
                COUNT(CASE WHEN e.expense_type = 'extra' THEN 1 END) AS extra_transaction_count
            FROM monthly_budgets b
            JOIN categories c ON c.id = b.category_id
            LEFT JOIN expenses e ON e.category_id = b.category_id 
                AND MONTH(e.expense_date) = b.month 
                AND YEAR(e.expense_date) = b.year
            WHERE b.month = ? AND b.year = ?
            GROUP BY b.id, b.category_id, c.name, b.month, b.year, b.allocated_amount, b.currency
            ORDER BY c.name ASC
        `;

        const rows = await pool.query(sql, [month, year]);
        const list = Array.isArray(rows) ? rows : [];
        const data = list.map((row) => ({
            budget_id: num(row.budget_id),
            category_id: num(row.category_id),
            category_name: row.category_name,
            month: num(row.month),
            year: num(row.year),
            allocated_amount: Number(row.allocated_amount),
            currency: row.currency,
            total_spent: Number(row.total_spent),
            remaining_amount: Number(row.remaining_amount),
            usage_percentage: Number(row.usage_percentage),
            standard_transaction_count: num(row.standard_transaction_count),
            extra_transaction_count: num(row.extra_transaction_count)
        }));

        const monthName = new Date(year, month - 1, 1).toLocaleString('default', { month: 'long' });

        res.json({
            status: "success",
            month,
            year,
            month_name: monthName,
            data
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

/**
 * UPDATE a monthly budget row (allocated_amount / currency).
 * Path: monthly_budgets.id (budget_id from GET budget-details).
 */
export const updateBudget = async (req, res) => {
    const budgetId = parseInt(req.params.id, 10);
    if (!Number.isFinite(budgetId)) {
        return res.status(400).json({ message: "Invalid budget id" });
    }

    const { allocated_amount, currency } = req.body;
    if (allocated_amount === undefined || allocated_amount === null || allocated_amount === "") {
        return res.status(400).json({ message: "allocated_amount is required" });
    }
    const alloc = Number(allocated_amount);
    if (!Number.isFinite(alloc) || alloc < 0) {
        return res.status(400).json({ message: "allocated_amount must be a non-negative number" });
    }

    try {
        const fields = ["allocated_amount = ?"];
        const params = [alloc];
        if (currency !== undefined && currency !== null && String(currency).trim() !== "") {
            fields.push("currency = ?");
            params.push(String(currency).trim().slice(0, 10));
        }
        params.push(budgetId);

        const result = await pool.query(
            `UPDATE monthly_budgets SET ${fields.join(", ")} WHERE id = ?`,
            params
        );
        const affected = typeof result?.affectedRows === "number" ? result.affectedRows : 0;
        if (affected === 0) {
            return res.status(404).json({ message: "Budget not found" });
        }

        const rows = await pool.query(
            `SELECT 
                b.id AS budget_id,
                b.category_id,
                c.name AS category_name,
                b.month,
                b.year,
                b.allocated_amount,
                b.currency,
                COALESCE(SUM(CASE WHEN e.expense_type = 'standard' THEN e.amount ELSE 0 END), 0) AS total_spent,
                (b.allocated_amount - COALESCE(SUM(CASE WHEN e.expense_type = 'standard' THEN e.amount ELSE 0 END), 0)) AS remaining_amount
            FROM monthly_budgets b
            JOIN categories c ON c.id = b.category_id
            LEFT JOIN expenses e ON e.category_id = b.category_id 
                AND MONTH(e.expense_date) = b.month 
                AND YEAR(e.expense_date) = b.year
            WHERE b.id = ?
            GROUP BY b.id, b.category_id, c.name, b.month, b.year, b.allocated_amount, b.currency`,
            [budgetId]
        );
        const row = Array.isArray(rows) ? rows[0] : rows;
        if (!row) {
            return res.json({
                status: "success",
                message: "Budget updated successfully",
                data: { budget_id: budgetId }
            });
        }

        res.json({
            status: "success",
            message: "Budget updated successfully",
            data: {
                budget_id: num(row.budget_id),
                category_id: num(row.category_id),
                category_name: row.category_name,
                month: num(row.month),
                year: num(row.year),
                allocated_amount: Number(row.allocated_amount),
                currency: row.currency,
                total_spent: Number(row.total_spent),
                remaining_amount: Number(row.remaining_amount)
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

/**
 * DELETE a monthly budget row (monthly_budgets.id). Does not delete category.
 */
export const deleteBudget = async (req, res) => {
    const budgetId = parseInt(req.params.id, 10);
    if (!Number.isFinite(budgetId)) {
        return res.status(400).json({ message: "Invalid budget id" });
    }

    try {
        const existing = await pool.query(
            "SELECT id, category_id, month, year FROM monthly_budgets WHERE id = ?",
            [budgetId]
        );
        const rows = Array.isArray(existing) ? existing : [];
        if (rows.length === 0) {
            return res.status(404).json({ message: "Budget not found" });
        }

        const meta = rows[0];
        await pool.query("DELETE FROM monthly_budgets WHERE id = ?", [budgetId]);

        res.json({
            status: "success",
            message: "Budget deleted successfully",
            deleted: {
                budget_id: budgetId,
                category_id: num(meta.category_id),
                month: num(meta.month),
                year: num(meta.year)
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};