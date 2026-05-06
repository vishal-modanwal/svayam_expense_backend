import crypto from "crypto";

export const otp = () => {
  return crypto.randomInt(100000, 999999).toString();
};

export const getOTPExpiry = () => {
  const expiryDate = new Date(Date.now() + 10 * 60000); // e.g., 10 mins from now
  return expiryDate;
};

