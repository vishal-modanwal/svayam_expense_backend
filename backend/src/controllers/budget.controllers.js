/**
 * GET BUDGET BY MONTH & YEAR
 * Query params se month aur year lekar specific budget details return karta hai.
 */
export const getBudgetByPeriod = async (req, res) => {
    // URL se query parameters lenge: /api/budgets/search?month=6&year=2026
    const { month, year } = req.query;

    if (!month || !year) {
        return res.status(400).json({ message: "Please provide both month and year." });
    }

    try {
        const rows = await pool.query(
            `SELECT b.*, c.name as category_name, 
             (SELECT SUM(amount) FROM expenses e 
              WHERE e.category_id = b.category_id 
              AND MONTH(e.created_at) = b.month 
              AND YEAR(e.created_at) = b.year) as total_spent
             FROM monthly_budgets b
             JOIN categories c ON b.category_id = c.id
             WHERE b.month = ? AND b.year = ?`,
            [month, year]
        );

        if (rows.length === 0) {
            return res.status(404).json({ message: "No budget found for the selected period." });
        }

        // Response mein total budget aur us waqt ka kharcha dono dikhayenge
        res.json({
            period: { month, year },
            budgets: rows
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};