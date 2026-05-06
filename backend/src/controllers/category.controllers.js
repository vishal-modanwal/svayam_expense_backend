import { pool } from "../db/index.js";

/**
 * 1. GET ALL CATEGORIES
 * Dropdowns aur settings table ke liye.
 */
export const getAllCategories = async (req, res) => {
    try {
        const rows = await pool.query(
            "SELECT id, name, description, created_at FROM categories ORDER BY name ASC"
        );
        res.json({ status: "success", data: rows });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

/**
 * 2. GET SINGLE CATEGORY
 * Editing ke waqt details fetch karne ke liye.
 */
export const getCategoryById = async (req, res) => {
    const { id } = req.params;
    try {
        const rows = await pool.query(
            "SELECT id, name, description FROM categories WHERE id = ?",
            [id]
        );
        if (rows.length === 0) return res.status(404).json({ message: "Category not found" });
        
        res.json({ status: "success", data: rows[0] });
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
        const result = await pool.query(
            "UPDATE categories SET name = ?, description = ? WHERE id = ?",
            [name, description, id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: "Category not found" });
        }

        res.json({ message: "Category updated successfully!" });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ message: "A category with this name already exists." });
        }
        res.status(500).json({ error: error.message });
    }
};

/**
 * 4. DELETE CATEGORY
 * Constraint: Agar is category mein budget ya expenses hain, toh logic handle karna hoga.
 */
export const deleteCategory = async (req, res) => {
    const { id } = req.params;

    try {
        // Step 1: Check if expenses exist for this category
        const expenses = await pool.query("SELECT id FROM expenses WHERE category_id = ? LIMIT 1", [id]);
        
        if (expenses.length > 0) {
            return res.status(400).json({ 
                message: "Cannot delete category. It has linked expenses. Please delete expenses first." 
            });
        }

        // Step 2: Delete linked monthly budgets first (or use ON DELETE CASCADE in DB)
        await pool.query("DELETE FROM monthly_budgets WHERE category_id = ?", [id]);

        // Step 3: Delete the category
        const result = await pool.query("DELETE FROM categories WHERE id = ?", [id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: "Category not found" });
        }

        res.json({ message: "Category deleted successfully!" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};