import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

export async function extractExpenseFromReceipt(imagePath) {
    // FIX 1: Correct model name
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const imageData = {
        inlineData: {
            data: Buffer.from(fs.readFileSync(imagePath)).toString("base64"),
            mimeType: "image/png", 
        },
    };

    const prompt = `
        Analyze this receipt image and extract expense details. 
        Return ONLY a JSON object with the following keys:
        - title: (short catchy title)
        - amount: (number)
        - payment_method: (string)
        - vendor: (string)
        - description: (brief summary)
        - expense_date: (YYYY-MM-DD)

        Strictly return only JSON, no extra text.
    `;

    try {
        const result = await model.generateContent([prompt, imageData]);
        const response = await result.response;
        let text = response.text();
        
        // FIX 2: Correct Regex for cleaning JSON
        // Humne backticks ko replace karne ke liye correct syntax use kiya hai
        text = text.replace(/```json|```/g, "").trim();
        
        const expenseData = JSON.parse(text);
        return expenseData;
    } catch (error) {
        console.error("OCR Error:", error.message); // message print karein clear error ke liye
        return null;
    }
}