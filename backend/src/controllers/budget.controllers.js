import { pool } from "../db/index.js";
import { selectRowArray, isMissingDeletedAtColumnError } from "../utils/mariaRows.js";
import { activeCategoryWhere } from "../utils/categoryArchive.js";

/**
 * GET BUDGET BY MONTH & YEAR
 * Query params se month aur year lekar specific budget details return karta hai.
 */
export const getBudgetByPeriod = async (req, res) => {
    const { month, year } = req.query;

    if (!month || !year) {
        return res.status(400).json({ message: "Please provide both month and year." });
    }

    try {
        const buildSql = (withActiveFilter) => {
            const catFilter = withActiveFilter ? ` AND ${activeCategoryWhere("c")}` : "";
            return `SELECT b.*, c.name as category_name,
                    (SELECT SUM(amount) FROM expenses e
                     WHERE e.category_id = b.category_id
                     AND MONTH(e.created_at) = b.month
                     AND YEAR(e.created_at) = b.year) AS total_spent
             FROM monthly_budgets b
             JOIN categories c ON b.category_id = c.id
             WHERE b.month = ? AND b.year = ?${catFilter}`;
        };

        let rows;
        try {
            rows = selectRowArray(await pool.query(buildSql(true), [month, year]));
        } catch (e) {
            if (isMissingDeletedAtColumnError(e)) {
                rows = selectRowArray(await pool.query(buildSql(false), [month, year]));
            } else {
                throw e;
            }
        }

        if (rows.length === 0) {
            return res.status(404).json({ message: "No budget found for the selected period." });
        }

        const budgets = rows.map((row) => ({
            ...row,
            category_archived: false,
            category_status: "active",
        }));

        res.json({
            scope: "active",
            period: { month, year },
            budgets,
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};
