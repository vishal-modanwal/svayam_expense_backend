import { Router } from "express";
import {
    createCategory,
    deleteCategory,
    getAllCategories,
    getArchivedCategoriesList,
    getCategoryById,
    updateCategory,
} from "../controllers/category.controllers.js";
import { getArchivedBudgets } from "../controllers/archived.controllers.js";
import { auth } from "../middlewares/auth.middleware.js";
import { adminOnly } from "../middlewares/admin.middleware.js";
import { requireActiveUser } from "../middlewares/activeUser.middleware.js";

const router = Router();
router.use(auth, requireActiveUser);
router.route("/archived").get(getArchivedCategoriesList);
router.route("/archived/budgets").get(getArchivedBudgets);
router.route("/").get(getAllCategories).post(adminOnly, createCategory);
router.route("/:id").get(getCategoryById);

//admin
router.route("/:id").post(adminOnly, updateCategory);
router.route('/:id').delete(adminOnly, deleteCategory);


export default router;