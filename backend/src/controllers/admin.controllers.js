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
 * GET TOTAL BUDGET SUMMARY
 * Current month ka total allocated budget aur total spent fetch karta hai.
 */
const num = (v) => (typeof v === 'bigint' ? Number(v) : Number(v || 0));

export const getTotalBudgetsSummary = async (req, res) => {
    try {
        // expense_date aligns with addExpense / budget month; counts always numbers (0 when none)
        const sql = `
            SELECT 
                SUM(allocated_amount) as grand_total_allocated,
                (SELECT COALESCE(SUM(amount), 0) FROM expenses 
                 WHERE MONTH(expense_date) = MONTH(CURRENT_DATE()) 
                 AND YEAR(expense_date) = YEAR(CURRENT_DATE())) as grand_total_spent,
                (SELECT COUNT(*) FROM expenses 
                 WHERE expense_type = 'standard'
                 AND MONTH(expense_date) = MONTH(CURRENT_DATE()) 
                 AND YEAR(expense_date) = YEAR(CURRENT_DATE())) as standard_transaction_count,
                (SELECT COUNT(*) FROM expenses 
                 WHERE expense_type = 'extra'
                 AND MONTH(expense_date) = MONTH(CURRENT_DATE()) 
                 AND YEAR(expense_date) = YEAR(CURRENT_DATE())) as extra_transaction_count
            FROM monthly_budgets
            WHERE month = MONTH(CURRENT_DATE()) 
            AND year = YEAR(CURRENT_DATE())
        `;

        const result = await pool.query(sql);
        const data = result[0] || {};

        const allocated = num(data.grand_total_allocated);
        const spent = num(data.grand_total_spent);
        const stdTx = num(data.standard_transaction_count);
        const extraTx = num(data.extra_transaction_count);

        const summary = {
            total_allocated: allocated,
            total_spent: spent,
            remaining_total: allocated - spent,
            overall_usage_hike: allocated ? ((spent / allocated) * 100).toFixed(2) : 0,
            standard_transaction_count: stdTx,
            extra_transaction_count: extraTx
        };

        res.json({
            status: "success",
            month: new Date().getMonth() + 1,
            year: new Date().getFullYear(),
            summary
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};


/**
 * GET CATEGORY-WISE BUDGET TABLE DATA
 * Purpose: Table view ke liye detailed breakdown.
 */
export const getCategoryWiseBudgets = async (req, res) => {
    try {
        const sql = `
            SELECT 
                c.id as category_id,
                c.name as category_name,
                b.allocated_amount as budget_limit,
                COALESCE(SUM(e.amount), 0) as total_spent,
                (b.allocated_amount - COALESCE(SUM(e.amount), 0)) as remaining_balance,
                CASE 
                    WHEN b.allocated_amount > 0 
                    THEN ROUND((COALESCE(SUM(e.amount), 0) / b.allocated_amount) * 100, 2)
                    ELSE 0 
                END as usage_percentage,
                COUNT(CASE WHEN e.expense_type = 'standard' THEN 1 END) as standard_transaction_count,
                COUNT(CASE WHEN e.expense_type = 'extra' THEN 1 END) as extra_transaction_count
            FROM categories c
            JOIN monthly_budgets b ON c.id = b.category_id
            LEFT JOIN expenses e ON c.id = e.category_id 
                AND MONTH(e.expense_date) = b.month 
                AND YEAR(e.expense_date) = b.year
            WHERE b.month = MONTH(CURRENT_DATE()) 
            AND b.year = YEAR(CURRENT_DATE())
            GROUP BY c.id, c.name, b.allocated_amount;
        `;

        const rows = await pool.query(sql);
        const list = Array.isArray(rows) ? rows : [];
        const data = list.map((row) => ({
            ...row,
            standard_transaction_count: num(row.standard_transaction_count),
            extra_transaction_count: num(row.extra_transaction_count)
        }));

        res.json({
            status: "success",
            month_name: new Date().toLocaleString('default', { month: 'long' }),
            year: new Date().getFullYear(),
            data
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};