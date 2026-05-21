import { pool } from "../db/index.js";
import { selectRowArray, isMissingArchivedColumnError } from "../utils/mariaRows.js";
import { ARCHIVED_NO, ARCHIVED_YES, activeCategoryWhere, archivedCategoryWhere } from "../utils/categoryArchive.js";
import {
    archiveCategoryCascade,
    hardDeleteCategoryCascade,
    isArchivedYes,
} from "../utils/archiveCategory.js";

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
 * POST /api/category — create category only (admin). Budget: POST /api/admin/budget.
 * Body: { name, description? }
 */
export const createCategory = async (req, res) => {
    const name = String(req.body?.name ?? "").trim();
    const description =
        req.body?.description !== undefined && req.body?.description !== null
            ? String(req.body.description).trim() || null
            : null;

    if (!name) {
        return res.status(400).json({ message: "name is required." });
    }
    if (name.length > 100) {
        return res.status(400).json({ message: "name must be at most 100 characters." });
    }

    try {
        const dup = selectRowArray(
            await pool.query(
                `SELECT id FROM categories WHERE name = ? AND archived = ? LIMIT 1`,
                [name, ARCHIVED_NO]
            )
        );
        if (dup.length > 0) {
            return res.status(409).json({
                message: "A category with this name already exists.",
                category_id: num(dup[0].id),
            });
        }

        const ins = await pool.query(
            `INSERT INTO categories (name, description, archived) VALUES (?, ?, ?)`,
            [name, description, ARCHIVED_NO]
        );
        const insertMeta = Array.isArray(ins) ? ins[0] : ins;
        const categoryId = num(insertMeta?.insertId);

        const rows = selectRowArray(
            await pool.query(
                `SELECT id, name, description, created_at, archived FROM categories WHERE id = ?`,
                [categoryId]
            )
        );

        res.status(201).json({
            message: "Category created. Set a monthly budget via POST /api/admin/budget.",
            data: mapCategoryRow(rows[0] ?? { id: categoryId, name, description, archived: ARCHIVED_NO }),
        });
    } catch (error) {
        if (error.code === "ER_DUP_ENTRY") {
            return res.status(409).json({ message: "A category with this name already exists." });
        }
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

const isPermanentDeleteQuery = (req) =>
    req.query.permanent === "true" ||
    req.query.permanent === "1" ||
    req.query.hard === "true" ||
    req.query.hard === "1";

/**
 * DELETE /api/category/:id — soft archive (default).
 * DELETE /api/category/:id?permanent=true — admin hard delete (irreversible).
 */
export const deleteCategory = async (req, res) => {
    const categoryId = parseInt(req.params.id, 10);
    if (!Number.isFinite(categoryId)) {
        return res.status(400).json({ message: "Invalid category id." });
    }

    if (isPermanentDeleteQuery(req)) {
        return hardDeleteCategory(req, res, categoryId);
    }

    let connection;
    try {
        const existing = selectRowArray(
            await pool.query("SELECT id, archived FROM categories WHERE id = ?", [
                categoryId,
            ])
        );
        if (existing.length === 0) {
            return res.status(404).json({ message: "Category not found" });
        }
        if (isArchivedYes(existing[0].archived)) {
            return res.status(400).json({
                message: "Category is already archived.",
                hint: "Use DELETE with ?permanent=true to remove permanently.",
            });
        }

        connection = await pool.getConnection();
        await connection.beginTransaction();
        const actorId = num(req.user?.id);
        await archiveCategoryCascade(
            connection,
            categoryId,
            Number.isFinite(actorId) ? actorId : null
        );
        await connection.commit();

        res.json({
            message: "Category archived successfully.",
            archived: true,
            permanent: false,
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

async function hardDeleteCategory(req, res, categoryId) {
    let connection;
    try {
        const existing = selectRowArray(
            await pool.query(
                "SELECT id, name, archived FROM categories WHERE id = ?",
                [categoryId]
            )
        );
        if (existing.length === 0) {
            return res.status(404).json({ message: "Category not found" });
        }

        const row = existing[0];
        connection = await pool.getConnection();
        await connection.beginTransaction();
        const { expenses_deleted, budgets_deleted } =
            await hardDeleteCategoryCascade(connection, categoryId);
        await connection.commit();

        res.json({
            message: "Category permanently deleted.",
            permanent: true,
            category_id: categoryId,
            category_name: row.name,
            was_archived: isArchivedYes(row.archived),
            deleted: {
                expenses: expenses_deleted,
                monthly_budgets: budgets_deleted,
                category: 1,
            },
        });
    } catch (error) {
        if (connection) await connection.rollback();
        if (error?.statusCode === 404) {
            return res.status(404).json({ message: "Category not found" });
        }
        if (error?.errno === 1451 || error?.code === "ER_ROW_IS_REFERENCED_2") {
            return res.status(409).json({
                message:
                    "Cannot permanently delete category: linked records still reference it.",
                code: "CATEGORY_DELETE_REFERENCED",
            });
        }
        res.status(500).json({ error: error.message });
    } finally {
        if (connection) connection.release();
    }
}
