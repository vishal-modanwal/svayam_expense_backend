import { pool } from "../db/index.js";
import { isMissingDeletedAtColumnError } from "../utils/mariaRows.js";

const num = (v) => (typeof v === "bigint" ? Number(v) : Number(v || 0));

/** Option B: archived rows stay in DB for history; API exposes flags for FE (read-only vs active). */
const mapCategoryRow = (row) => {
    const archived = row.deleted_at != null;
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
 * 1. GET ALL CATEGORIES — active only (archived: GET /api/admin/archived/categories).
 */
export const getAllCategories = async (req, res) => {
    try {
        let rows;
        try {
            rows = await pool.query(
                "SELECT id, name, description, created_at, deleted_at FROM categories WHERE deleted_at IS NULL ORDER BY name ASC"
            );
        } catch (e) {
            if (!isMissingDeletedAtColumnError(e)) throw e;
            rows = await pool.query(
                "SELECT id, name, description, created_at FROM categories ORDER BY name ASC"
            );
        }

        const list = Array.isArray(rows) ? rows : [];
        res.json({
            status: "success",
            scope: "active",
            data: list.map(mapCategoryRow),
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

/**
 * 2. GET SINGLE CATEGORY
 * Active: any authenticated user. Archived: admin only (history read); others get 404.
 */
export const getCategoryById = async (req, res) => {
    const { id } = req.params;
    try {
        let list;
        try {
            const rows = await pool.query(
                "SELECT id, name, description, created_at, deleted_at FROM categories WHERE id = ?",
                [id]
            );
            list = Array.isArray(rows) ? rows : [];
        } catch (e) {
            if (!isMissingDeletedAtColumnError(e)) throw e;
            const rows = await pool.query(
                "SELECT id, name, description, created_at FROM categories WHERE id = ?",
                [id]
            );
            list = Array.isArray(rows) ? rows : [];
        }
        if (list.length === 0) return res.status(404).json({ message: "Category not found" });

        const row = list[0];
        const archived = row.deleted_at != null;
        if (archived && req.user?.role !== "admin") {
            return res.status(404).json({ message: "Category not found" });
        }

        res.json({ status: "success", data: mapCategoryRow(row) });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

/**
 * 3. UPDATE CATEGORY
 * Admin category ka naam ya description change kar sake.
 */
export const updateCategory = async (req, res) => {
    const { id } = req.params;
    const { name, description } = req.body;

    try {
        let curList;
        try {
            const cur = await pool.query("SELECT deleted_at FROM categories WHERE id = ?", [id]);
            curList = Array.isArray(cur) ? cur : [];
        } catch (e) {
            if (!isMissingDeletedAtColumnError(e)) throw e;
            const cur = await pool.query("SELECT id FROM categories WHERE id = ?", [id]);
            curList = Array.isArray(cur) ? cur : [];
        }
        if (curList.length === 0) {
            return res.status(404).json({ message: "Category not found" });
        }
        if (curList[0].deleted_at != null) {
            return res.status(400).json({
                message: "Cannot update an archived category (history only).",
                category_status: "history_only",
            });
        }

        let result;
        try {
            result = await pool.query(
                "UPDATE categories SET name = ?, description = ? WHERE id = ? AND deleted_at IS NULL",
                [name, description, id]
            );
        } catch (e) {
            if (!isMissingDeletedAtColumnError(e)) throw e;
            result = await pool.query(
                "UPDATE categories SET name = ?, description = ? WHERE id = ?",
                [name, description, id]
            );
        }

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
 * 4. SOFT DELETE CATEGORY
 * Sets deleted_at; renames row to free UNIQUE(name) for a new category with the same label.
 * Linked expenses and monthly_budgets rows are kept for history.
 */
export const deleteCategory = async (req, res) => {
    const { id } = req.params;

    try {
        let rows;
        try {
            const existing = await pool.query("SELECT id, deleted_at FROM categories WHERE id = ?", [id]);
            rows = Array.isArray(existing) ? existing : [];
        } catch (e) {
            if (!isMissingDeletedAtColumnError(e)) throw e;
            return res.status(503).json({
                message:
                    "Category archive requires column categories.deleted_at. Run the idempotent upgrade at the end of Schema.sql, then retry.",
                code: "SCHEMA_MISSING_deleted_at",
            });
        }
        if (rows.length === 0) {
            return res.status(404).json({ message: "Category not found" });
        }
        if (rows[0].deleted_at != null) {
            return res.status(400).json({ message: "Category is already archived." });
        }

        const result = await pool.query(
            `UPDATE categories
             SET deleted_at = CURRENT_TIMESTAMP,
                 name = CONCAT(SUBSTRING(TRIM(name), 1, 75), '·archived·', id)
             WHERE id = ? AND deleted_at IS NULL`,
            [id]
        );

        const affected = typeof result?.affectedRows === "number" ? result.affectedRows : 0;
        if (affected === 0) {
            return res.status(404).json({ message: "Category not found" });
        }

        res.json({
            message: "Category archived successfully.",
            archived: true,
            policy: {
                expenses_and_budgets: "retained_for_history",
                new_expenses_and_budget_assignments: "use_active_categories_only",
                category_status: "history_only",
            },
        });
    } catch (error) {
        if (isMissingDeletedAtColumnError(error)) {
            return res.status(503).json({
                message:
                    "Category archive requires column categories.deleted_at. Run the idempotent upgrade at the end of Schema.sql, then retry.",
                code: "SCHEMA_MISSING_deleted_at",
            });
        }
        res.status(500).json({ error: error.message });
    }
};
