import { ARCHIVED_YES, ARCHIVED_NO } from "./categoryArchive.js";
import { softArchiveExpensesByCategory } from "./expenseArchive.js";

/**
 * Mark category and all linked budgets/expenses as archived (history only).
 * @param {import("mariadb").PoolConnection} conn
 * @param {number} categoryId
 * @param {number|null} [deletedByUserId] — admin who triggered archive (expense audit)
 */
export async function archiveCategoryCascade(conn, categoryId, deletedByUserId = null) {
    await conn.query(
        `UPDATE categories SET archived = ? WHERE id = ? AND archived = ?`,
        [ARCHIVED_YES, categoryId, ARCHIVED_NO]
    );
    await conn.query(
        `UPDATE monthly_budgets SET archived = ? WHERE category_id = ? AND archived = ?`,
        [ARCHIVED_YES, categoryId, ARCHIVED_NO]
    );
    await softArchiveExpensesByCategory(conn, categoryId, deletedByUserId);
}

export function isArchivedYes(value) {
    return String(value).toLowerCase() === ARCHIVED_YES;
}
