import { pool } from "../db/index.js";
import { selectRowArray, isMissingArchivedColumnError } from "../utils/mariaRows.js";
import { ARCHIVED_NO, ARCHIVED_YES, activeCategoryWhere, archivedCategoryWhere } from "../utils/categoryArchive.js";
import { archiveCategoryCascade, isArchivedYes } from "../utils/archiveCategory.js";

const num = (v) => (typeof v === "bigint" ? Number(v) : Number(v || 0));

const mapCategoryRow = (row) => {
    const archived = isArchivedYes(row.archived);
    return {
        id: num(row.id),
        name: row.name,
        description: row.description ?? null,
        created_at: row.created_at,
        archived,
        category_status: archived ? "history_only" : "active",
    };
};

/**
 * GET ALL CATEGORIES — active only (archived: GET /api/category/archived).
 */
export const getAllCategories = async (req, res) => {
    try {
        const rows = selectRowArray(
            await pool.query(
                `SELECT id, name, description, created_at, archived
                 FROM categories WHERE ${activeCategoryWhere("categories")}
                 ORDER BY name ASC`
            )
        );
        res.json({
            status: "success",
            scope: "active",
            data: rows.map(mapCategoryRow),
        });
    } catch (error) {
        if (isMissingArchivedColumnError(error)) {
            return res.status(503).json({
                message: "Run the idempotent upgrade at the end of Schema.sql (archived columns), then retry.",
                code: "SCHEMA_MISSING_archived",
            });
        }
        res.status(500).json({ error: error.message });
    }
};

/**
 * GET ARCHIVED CATEGORIES (any authenticated user — read-only history).
 */
export const getArchivedCategoriesList = async (req, res) => {
    try {
        const rows = selectRowArray(
            await pool.query(
                `SELECT id, name, description, created_at, archived
                 FROM categories
                 WHERE ${archivedCategoryWhere("categories")}
                 ORDER BY created_at DESC, id DESC`
            )
        );
        res.json({
            status: "success",
            scope: "archived",
            data: rows.map(mapCategoryRow),
        });
    } catch (error) {
        if (isMissingArchivedColumnError(error)) {
            return res.json({ status: "success", scope: "archived", data: [] });
        }
        res.status(500).json({ error: error.message });
    }
};

/**
 * GET SINGLE CATEGORY — active: any user; archived: any authenticated user (read-only).
 */
export const getCategoryById = async (req, res) => {
    const { id } = req.params;
    try {
        const list = selectRowArray(
            await pool.query(
                `SELECT id, name, description, created_at, archived FROM categories WHERE id = ?`,
                [id]
            )
        );
        if (list.length === 0) return res.status(404).json({ message: "Category not found" });

        res.json({ status: "success", data: mapCategoryRow(list[0]) });
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

/**
 * UPDATE CATEGORY (active only).
 */
export const updateCategory = async (req, res) => {
    const { id } = req.params;
    const { name, description } = req.body;

    try {
        const curList = selectRowArray(
            await pool.query("SELECT archived FROM categories WHERE id = ?", [id])
        );
        if (curList.length === 0) {
            return res.status(404).json({ message: "Category not found" });
        }
        if (isArchivedYes(curList[0].archived)) {
            return res.status(400).json({
                message: "Cannot update an archived category (history only).",
                category_status: "history_only",
            });
        }

        const dup = selectRowArray(
            await pool.query(
                `SELECT id FROM categories WHERE name = ? AND archived = ? AND id <> ? LIMIT 1`,
                [name, ARCHIVED_NO, id]
            )
        );
        if (dup.length > 0) {
            return res.status(400).json({ message: "A category with this name already exists." });
        }

        const result = await pool.query(
            `UPDATE categories SET name = ?, description = ? WHERE id = ? AND archived = ?`,
            [name, description, id, ARCHIVED_NO]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: "Category not found" });
        }

        res.json({ message: "Category updated successfully!" });
    } catch (error) {
        if (error.code === "ER_DUP_ENTRY") {
            return res.status(400).json({ message: "A category with this name already exists." });
        }
        res.status(500).json({ error: error.message });
    }
};

/**
 * ARCHIVE CATEGORY — sets archived=yes on category, budgets, and expenses (name unchanged).
 */
export const deleteCategory = async (req, res) => {
    const { id } = req.params;

    let connection;
    try {
        const existing = selectRowArray(
            await pool.query("SELECT id, archived FROM categories WHERE id = ?", [id])
        );
        if (existing.length === 0) {
            return res.status(404).json({ message: "Category not found" });
        }
        if (isArchivedYes(existing[0].archived)) {
            return res.status(400).json({ message: "Category is already archived." });
        }

        connection = await pool.getConnection();
        await connection.beginTransaction();
        const actorId = num(req.user?.id);
        await archiveCategoryCascade(connection, id, Number.isFinite(actorId) ? actorId : null);
        await connection.commit();

        res.json({
            message: "Category archived successfully.",
            archived: true,
            policy: {
                expenses_and_budgets: "marked_archived_for_history",
                new_expenses_and_budget_assignments: "use_active_categories_only",
                category_status: "history_only",
            },
        });
    } catch (error) {
        if (connection) await connection.rollback();
        if (isMissingArchivedColumnError(error)) {
            return res.status(503).json({
                message: "Category archive requires `archived` columns. Run Schema.sql idempotent upgrade.",
                code: "SCHEMA_MISSING_archived",
            });
        }
        res.status(500).json({ error: error.message });
    } finally {
        if (connection) connection.release();
    }
};
