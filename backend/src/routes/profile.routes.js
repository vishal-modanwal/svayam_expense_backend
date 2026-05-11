import express from 'express';
import { auth } from '../middlewares/auth.middleware.js';
import {
    forgotPassword,
    getMe,
    getMyActivityStatus,
    resetPassword,
    updateProfile
} from '../controllers/profile.controllers.js';

const router = express.Router();

router.get('/status', auth, getMyActivityStatus);
router.route('/').get(auth , getMe);
router.route('/update').put(auth , updateProfile);
router.route('/forgetPassword').post(forgotPassword);
router.route('/resetPassword').post(resetPassword);
export default router;