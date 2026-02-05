const { default: makeWASocket, useMultiFileAuthState, delay, fetchLatestBaileysVersion, jidNormalizedUser } = require("@whiskeysockets/baileys");
const admin = require("firebase-admin");
const express = require("express");
const QRCode = require("qrcode");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const Groq = require("groq-sdk");
const fs = require("fs");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 10000;
let qrCodeImage = "";
let db;

// --- تحسين التعرف على الأرقام ---
const formatNum = (num) => num.endsWith("@s.whatsapp.net") ? num : `${num}@s.whatsapp.net`;
const OWNER = formatNum(process.env.OWNER_NUMBER || "966554526287");
const WIFE1 = formatNum(process.env.WIFE_NUMBER || "967782203551");
const WIFE2 = formatNum(process.env.WIFE2_NUMBER || "966599741982");
const FATHER = formatNum(process.env.FATHER_NUMBER || "967783015253");

let isBotActive = true;
const chatSessions = {}; // هنا سنخزن "الذاكرة"

// --- البرومبت "البشري" المتطور ---
const BASE_SYSTEM_PROMPT = `أنت "مساعد الراشد" الشخصي. لست مجرد بوت، أنت سكرتير ذكي، لبق، ومحترم.
- إذا كان المتحدث هو (الأب): كن في غاية الخضوع والأدب (يا عمي، أبشر، تحت أمرك).
- إذا كانت (الزوجة): كن حنوناً، رومانسياً، ومختصراً بدافئ.
- للعامة والزبائن: كن رسمياً، محترفاً، ولا تكرر جملة الترحيب إذا استمر الحوار.
- ممنوع التكرار: إذا سألك الشخص نفس السؤال، غير أسلوبك تماماً كبشر.
- تحدث بلهجة سعودية بيضاء مهذبة.`;

// (دالة وهمية للصوت سنشرحها بالأسفل)
async function sendSaudiVoice(sock, jid, text) {
    // هذه الدالة تحتاج اشتراك في ElevenLabs أو ما يشابهها
    console.log("إرسال صوتي قيد التطوير...");
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const sock = makeWASocket({ auth: state, printQRInTerminal: false });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const remoteJid = jidNormalizedUser(msg.key.remoteJid);
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (!text) return;

        // منطق المالك (راشد)
        if (remoteJid === OWNER) {
            if (text === "123123") { isBotActive = false; return await sock.sendMessage(remoteJid, { text: "⚠️ تم إيقاف المساعد." }); }
            if (text === "321321") { isBotActive = true; return await sock.sendMessage(remoteJid, { text: "✅ المساعد جاهز لخدمتك." }); }
        }

        if (!isBotActive) return;

        // إدارة الذاكرة (Context)
        if (!chatSessions[remoteJid]) {
            chatSessions[remoteJid] = { history: [], lastInteraction: Date.now() };
        }
        const session = chatSessions[remoteJid];
        session.history.push({ role: "user", content: text });
        if (session.history.length > 10) session.history.shift(); // حفظ آخر 10 رسائل فقط

        // تحديد الشخصية بدقة بناءً على الرقم "المطهر"
        let persona = "عامة وزبائن";
        let systemContent = BASE_SYSTEM_PROMPT;

        if (remoteJid === FATHER) systemContent += "\nملاحظة: هذا والد الراشد، تذلل له في الكلام.";
        else if (remoteJid === WIFE1 || remoteJid === WIFE2) systemContent += "\nملاحظة: هذه زوجة الراشد، كن حنوناً جداً.";

        // توليد الرد باستخدام الذاكرة
        try {
            const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
            const completion = await groq.chat.completions.create({
                messages: [
                    { role: "system", content: systemContent },
                    ...session.history
                ],
                model: "llama-3.3-70b-versatile",
            });

            const responseText = completion.choices[0].message.content;
            session.history.push({ role: "assistant", content: responseText });

            // إرسال الرد
            await sock.sendMessage(remoteJid, { text: responseText });
            
            // (اختياري) إرسال صوت إذا كان الشخص مهماً
            if (remoteJid === FATHER || remoteJid === WIFE1) {
                // هنا يمكن استدعاء دالة الصوت
            }

        } catch (e) {
            console.error("خطأ في الذكاء الاصطناعي:", e);
        }
    });
}
// ... بقية كود Express و Firebase
startBot();
