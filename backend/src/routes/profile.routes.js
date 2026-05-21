import express from 'express';
import { auth } from '../middlewares/auth.middleware.js';
import {
    forgotPassword,
    getMe,
    getMyActivityStatus,
    resetPassword,
    updateProfile
} from '../controllers/profile.controllers.js';
import { getMyMonthlyBudget } from '../controllers/userMonthlyBudget.controllers.js';
import {
    getMyActivationRequest,
    submitActivationRequest,
} from '../controllers/activationRequest.controllers.js';
import { requireActiveUser } from '../middlewares/activeUser.middleware.js';

const router = express.Router();

router.get('/status', auth, getMyActivityStatus);
router.route('/activation-request')
    .get(auth, getMyActivationRequest)
    .post(auth, submitActivationRequest);
router.get('/monthly-budget', auth, requireActiveUser, getMyMonthlyBudget);
router.route('/').get(auth , getMe);
router.route('/update').put(auth, requireActiveUser, updateProfile);
router.route('/forgetPassword').post(forgotPassword);
router.route('/resetPassword').post(resetPassword);
export default router;