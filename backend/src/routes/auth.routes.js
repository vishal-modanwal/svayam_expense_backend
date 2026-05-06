import { Router } from "express";
import { checkEmailVerification, login, register, sendVerificationEmail } from "../controllers/auth.controllers.js";

const router = Router();
router.route('/sendEmailOtp').post(sendVerificationEmail);
router.route('/verifyEmailOtp').post(checkEmailVerification);
router.route('/register').post(register);
router.route('/login').post(login);


export default router;