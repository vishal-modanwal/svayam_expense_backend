import fs from 'fs';
import { extractExpenseFromReceipt } from '../utils/aiOcr.js';

/**
 * POST multipart field `receipt`.
 * Flow: temp disk file → Gemini OCR → JSON body → temp file unlinked.
 * Does not create an expense or keep the upload. A later POST /api/expense (multipart)
 * must include `receipt` again if the client wants that image saved on the expense.
 */
export const scanReceiptForForm = async (req, res) => {
    if (!req.file?.path) {
        return res.status(400).json({ status: 'error', message: 'receipt image is required (multipart field: receipt).' });
    }

    const filePath = req.file.path;

    try {
        const data = await extractExpenseFromReceipt(filePath);
        if (!data) {
            return res.status(422).json({
                status: 'error',
                message: 'Could not extract expense details from this image. Try a clearer photo or different angle.',
            });
        }
        return res.status(200).json({ status: 'ok', data });
    } catch (err) {
        console.error('scanReceiptForForm:', err?.message || err);
        return res.status(500).json({ status: 'error', message: 'Receipt scan failed.' });
    } finally {
        try {
            if (filePath && fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        } catch (unlinkErr) {
            console.error('scanReceiptForForm cleanup:', unlinkErr?.message || unlinkErr);
        }
    }
};
