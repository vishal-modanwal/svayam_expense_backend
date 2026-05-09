import { pool } from "../db/index.js";
import dotenv from "dotenv";
dotenv.config();

const DEFAULT_MODEL = "gemini-2.5-flash";

const SYSTEM_PROMPT = `You are "Svayam Expense Assistant", a concise helper for the Svayam Expense Tracker app.
Context: users log expenses (standard vs admin-only "extra"), categories, monthly budgets, receipts, PDF reports, admin summaries.
Rules:
- Answer the user's question clearly and practically. Use short paragraphs or bullets when helpful.
- If the question needs their private numbers (totals, balances), say you cannot see live account data unless they paste it—but you may explain how to read their dashboard or which API/screens to use.
- Never ask for passwords, OTPs, or API keys. Never fabricate JSON or endpoints that do not exist.
- Stay in English unless the user writes in another language; then reply in that language.`;

/**
 * Optional tiny context so Gemini can personalize (no secrets).
 */
async function buildUserContextSnippet(userId) {
    try {
        const rows = await pool.query(
            "SELECT id, name, email, role FROM users WHERE id = ? AND is_active = 1 LIMIT 1",
            [userId]
        );
        const list = Array.isArray(rows) ? rows : [];
        if (!list.length) return "";
        const u = list[0];
        return `\nCurrent user (for tone only): id=${u.id}, name=${u.name ?? "unknown"}, role=${u.role ?? "user"}. Do not repeat these as sensitive data.`;
    } catch {
        return "";
    }
}

export const chatMessage = async (req, res) => {
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
        return res.status(503).json({
            status: "error",
            message: "Chat is not configured. Set GEMINI_API_KEY in the server environment."
        });
    }

    const raw = req.body?.message ?? req.body?.query ?? "";
    const message = String(raw).trim();
    if (!message) {
        return res.status(400).json({ status: "error", message: "message (or query) is required" });
    }
    if (message.length > 8000) {
        return res.status(400).json({ status: "error", message: "message too long (max 8000 characters)" });
    }

    const model = (process.env.GEMINI_MODEL || DEFAULT_MODEL).trim();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    let userTail = "";
    if (req.user?.id) {
        userTail = await buildUserContextSnippet(req.user.id);
    }

    try {
        const geminiRes = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                systemInstruction: {
                    parts: [{ text: SYSTEM_PROMPT + userTail }]
                },
                contents: [
                    {
                        role: "user",
                        parts: [{ text: message }]
                    }
                ],
                generationConfig: {
                    temperature: 0.65,
                    maxOutputTokens: 2048
                }
            })
        });

        const data = await geminiRes.json().catch(() => ({}));

        if (!geminiRes.ok) {
            const errMsg =
                data?.error?.message ||
                data?.error?.status ||
                `Gemini API error (${geminiRes.status})`;
            console.error("Gemini error:", errMsg);
            return res.status(502).json({
                status: "error",
                message: "Assistant could not complete the request.",
                detail: process.env.NODE_ENV === "development" ? errMsg : undefined
            });
        }

        const parts = data?.candidates?.[0]?.content?.parts;
        const text =
            Array.isArray(parts) && parts.length
                ? parts.map((p) => p.text || "").join("")
                : "";

        if (!text) {
            const blockReason = data?.candidates?.[0]?.finishReason || data?.promptFeedback?.blockReason;
            return res.status(200).json({
                status: "success",
                reply:
                    blockReason === "SAFETY" || blockReason === "BLOCKLIST"
                        ? "I cannot answer that topic. Try rephrasing in the context of expense tracking."
                        : "No response was generated. Try a shorter or clearer question.",
                model,
                finish_reason: blockReason || "UNKNOWN"
            });
        }

        res.json({
            status: "success",
            reply: text.trim(),
            model
        });
    } catch (err) {
        console.error("chatMessage:", err);
        res.status(500).json({ status: "error", message: err.message || "Chat failed" });
    }
};
