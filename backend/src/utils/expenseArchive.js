import { ARCHIVED_NO, ARCHIVED_YES } from "./categoryArchive.js";

/** Why an expense left the active list (NULL while active). */
export const EXPENSE_ARCHIVE_REASON = {
    CATEGORY_ARCHIVED: "category_archived",
    USER_DELETED: "user_deleted",
    ADMIN_DELETED: "admin_deleted",
};

/**
 * Soft-archive expenses for a category (category archive cascade).
 * @param {import("mariadb").PoolConnection} conn
 * @param {number} categoryId
 * @param {number|null} deletedByUserId
 */
export async function softArchiveExpensesByCategory(conn, categoryId, deletedByUserId = null) {
    await conn.query(
        `UPDATE expenses
         SET archived = ?, archive_reason = ?, deleted_at = CURRENT_TIMESTAMP, deleted_by = ?
         WHERE category_id = ? AND archived = ?`,
        [
            ARCHIVED_YES,
            EXPENSE_ARCHIVE_REASON.CATEGORY_ARCHIVED,
            deletedByUserId,
            categoryId,
            ARCHIVED_NO,
        ]
    );
}

/**
 * Soft-archive a single expense (user or admin delete).
 * @returns {number} affectedRows
 */
export async function softArchiveExpenseById(conn, expenseId, reason, deletedByUserId) {
    const result = await conn.query(
        `UPDATE expenses
         SET archived = ?, archive_reason = ?, deleted_at = CURRENT_TIMESTAMP, deleted_by = ?
         WHERE id = ? AND archived = ?`,
        [ARCHIVED_YES, reason, deletedByUserId, expenseId, ARCHIVED_NO]
    );
    return typeof result?.affectedRows === "number" ? result.affectedRows : 0;
}

/**
 * Restore a soft-archived expense to active (clears audit fields).
 * @returns {number} affectedRows
 */
export async function restoreArchivedExpenseById(conn, expenseId) {
    const result = await conn.query(
        `UPDATE expenses
         SET archived = ?, archive_reason = NULL, deleted_at = NULL, deleted_by = NULL
         WHERE id = ? AND archived = ?`,
        [ARCHIVED_NO, expenseId, ARCHIVED_YES]
    );
    return typeof result?.affectedRows === "number" ? result.affectedRows : 0;
}
