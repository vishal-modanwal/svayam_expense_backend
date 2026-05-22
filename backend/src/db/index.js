import * as mariadb from "mariadb";
import dotenv from 'dotenv';

dotenv.config();

export const pool = mariadb.createPool({
    host: process.env.DB_HOST, 
    user: process.env.DB_USER, 
    password: process.env.DB_PASSWORD,
    database: 'Svayam_Expense_Tracker',
    charset: 'utf8mb4',
    connectionLimit: 10
});

export const testConnection = async () => {
  let conn;
  try {
    conn = await pool.getConnection();
    console.log("✅ MariaDB Connected Successfully");
  } catch (error) {
    console.error("❌ DB Connection Failed:", error.message);
  } finally {
    if (conn) conn.release(); // always release
  }
};

