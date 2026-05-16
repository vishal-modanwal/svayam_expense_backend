import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const receiptsDir = path.join(__dirname, '../public/receipts');
/** Short-lived uploads for OCR only; files are deleted after scan. */
const receiptScanTempDir = path.join(__dirname, '../temp/receipt-scan');

if (!fs.existsSync(receiptsDir)) {
    fs.mkdirSync(receiptsDir, { recursive: true });
}
if (!fs.existsSync(receiptScanTempDir)) {
    fs.mkdirSync(receiptScanTempDir, { recursive: true });
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

const imageMime = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const scanStorage = multer.diskStorage({
    destination: (_req, _file, cb) => {
        cb(null, receiptScanTempDir);
    },
    filename: (_req, file, cb) => {
        const safe = String(file.originalname || 'receipt').replace(/\s+/g, '_');
        cb(null, `${Date.now()}-${safe}`);
    },
});

/**
 * Scan-only upload: temp/receipt-scan, deleted after OCR. Not the same as `upload`
 * (public/receipts) used on expense create/update — saving a receipt requires a second request with `receipt` there.
 */
const uploadReceiptScan = multer({
    storage: scanStorage,
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        if (imageMime.has(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Only JPEG, PNG, WebP, or GIF images are allowed for receipt scan.'));
        }
    },
});

/** Scan route only: parses multipart field `receipt`; 400 on type/size errors. */
export const parseReceiptScanUpload = (req, res, next) => {
    uploadReceiptScan.single('receipt')(req, res, (err) => {
        if (err) {
            const msg =
                err.code === 'LIMIT_FILE_SIZE'
                    ? 'Receipt image too large (max 8MB).'
                    : err.message || 'Receipt upload failed.';
            return res.status(400).json({ status: 'error', message: msg });
        }
        next();
    });
};

/** Only parse multipart when Content-Type is multipart (JSON body stays on JSON requests). */
export const optionalReceiptUpload = (req, res, next) => {
    const ct = req.headers['content-type'] || '';
    if (ct.includes('multipart/form-data')) {
        return upload.single('receipt')(req, res, next);
    }
    next();
};
