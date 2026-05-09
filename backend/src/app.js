import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import authRouter from "./routes/auth.routes.js";
import profileRouter from "./routes/profile.routes.js";
import adminRouter from "./routes/admin.routes.js";
import categoryRouter from "./routes/categories.routes.js";
import expenseRouter from "./routes/expense.routes.js";
import tableMetaRouter from "./routes/tableMeta.routes.js";
import chatRouter from "./routes/chat.routes.js";

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
app.use('/api/profile' , profileRouter);
app.use('/api/admin' , adminRouter);
app.use('/api/category' , categoryRouter);
app.use('/api/expense' , expenseRouter);
app.use('/api/meta', tableMetaRouter);
app.use('/api/chat', chatRouter);

// Health Check
app.get('/', (req, res) => {
    res.send('Svayam Expense Tracker is running...');
});

export default app;