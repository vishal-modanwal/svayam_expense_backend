import { Router } from "express";
import { deleteCategory, getAllCategories, getCategoryById, updateCategory } from "../controllers/category.controllers.js";
import { auth } from "../middlewares/auth.middleware.js";
import { adminOnly } from "../middlewares/admin.middleware.js";

const router = Router();
router.route('/').get(auth , getAllCategories);
router.route('/:id').get(auth , getCategoryById);

//admin
router.route('/:id').post(auth , adminOnly , updateCategory);
router.route('/:id').delete(auth , adminOnly , deleteCategory);


export default router;