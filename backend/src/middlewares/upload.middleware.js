import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const receiptsDir = path.join(__dirname, '../public/receipts');

if (!fs.existsSync(receiptsDir)) {
    fs.mkdirSync(receiptsDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => {
        cb(null, receiptsDir);
    },
    filename: (_req, file, cb) => {
        const safe = String(file.originalname || 'receipt').replace(/\s+/g, '_');
        cb(null, `${Date.now()}-${safe}`);
    }
});

export const upload = multer({ storage });

/** Only parse multipart when Content-Type is multipart (JSON body stays on JSON requests). */
export const optionalReceiptUpload = (req, res, next) => {
    const ct = req.headers['content-type'] || '';
    if (ct.includes('multipart/form-data')) {
        return upload.single('receipt')(req, res, next);
    }
    next();
};
