import express from 'express';
import { auth } from '../middlewares/auth.middleware.js';
import { forgotPassword, getMe, updateProfile , resetPassword} from '../controllers/profile.controllers.js';

const router = express.Router();

router.route('/').get(auth , getMe);
router.route('/update').put(auth , updateProfile);
router.route('/forgetPassword').post(forgotPassword);
router.route('/resetPassword').post(resetPassword);
export default router;