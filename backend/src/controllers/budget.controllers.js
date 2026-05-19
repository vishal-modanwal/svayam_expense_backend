import { pool } from "../db/index.js";
import { selectRowArray, isMissingArchivedColumnError } from "../utils/mariaRows.js";
import {
    activeCategoryWhere,
    activeBudgetWhere,
    activeExpenseWhere,
} from "../utils/categoryArchive.js";

/**
 * GET BUDGET BY MONTH & YEAR — active (archived=no) rows only.
 */
export const getBudgetByPeriod = async (req, res) => {
    const { month, year } = req.query;

    if (!month || !year) {
        return res.status(400).json({ message: "Please provide both month and year." });
    }

    try {
        const rows = selectRowArray(
            await pool.query(
                `SELECT b.*, c.name as category_name,
                    (SELECT SUM(amount) FROM expenses e
                     WHERE e.category_id = b.category_id
                     AND e.archived = 'no'
                     AND MONTH(e.expense_date) = b.month
                     AND YEAR(e.expense_date) = b.year) AS total_spent
             FROM monthly_budgets b
             JOIN categories c ON b.category_id = c.id
             WHERE b.month = ? AND b.year = ?
               AND ${activeBudgetWhere("b")}
               AND ${activeCategoryWhere("c")}
             ORDER BY c.name ASC`,
                [month, year]
            )
        );

        if (rows.length === 0) {
            return res.status(404).json({ message: "No budget found for the selected period." });
        }

        const budgets = rows.map((row) => ({
            ...row,
            category_archived: false,
            category_status: "active",
            archived: false,
        }));

        res.json({
            scope: "active",
            period: { month, year },
            budgets,
        });
    } catch (error) {
        if (isMissingArchivedColumnError(error)) {
            return res.status(503).json({
                message: "Run Schema.sql archived upgrade, then retry.",
                code: "SCHEMA_MISSING_archived",
            });
        }
        res.status(500).json({ error: error.message });
    }
};
