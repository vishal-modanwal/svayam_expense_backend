import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import authRouter from "./routes/auth.routes.js"

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static Folder for Receipts Storage
app.use('/uploads', express.static(path.join(__dirname, 'public/receipts')));

app.use((req , res , next) =>{
    console.log(`${req.method} ${req.url}`);
    next();
})

app.use('/api/auth' , authRouter);

// Health Check
app.get('/', (req, res) => {
    res.send('Svayam Expense Tracker API is running...');
});

export default app;