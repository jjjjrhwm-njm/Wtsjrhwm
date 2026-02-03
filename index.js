const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const admin = require("firebase-admin");
const express = require("express");
const QRCode = require("qrcode");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const Groq = require("groq-sdk");
const { Mistral } = require("@mistralai/mistralai");
const fs = require("fs");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 10000;
let qrCodeImage = "";
let db;

// تعليمات الشخصية (سكرتير نجم الإبداع)
const SYSTEM_PROMPT = "أنت سكرتير راشد (نجم الإبداع). ردودك مختصرة جداً، مهنية، وتتعامل كإنسان وقور. يمنع منعاً باتاً أي محتوى رومانسي أو مخل بالآداب. لست فضولياً، أجب على قدر السؤال فقط.";

// ١. إعداد الخزنة (Firebase)
if (process.env.FIREBASE_CONFIG) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
        if (!admin.apps.length) {
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
            db = admin.firestore();
            console.log("✅ تم ربط الخزنة بنجاح");
        }
    } catch (e) { console.log("❌ خطأ Firebase:", e.message); }
}

async function startBot() {
    if (!fs.existsSync('./auth_info')) fs.mkdirSync('./auth_info');
    
    if (db) {
        try {
            const doc = await db.collection('session').doc('whatsapp').get();
            if (doc.exists) {
                fs.writeFileSync('./auth_info/creds.json', JSON.stringify(doc.data()));
                console.log("📂 تم استعادة ملف الدخول من الخزنة");
            }
        } catch (e) { console.log("⚠️ لا توجد جلسة محفوظة"); }
    }

    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        browser: ["Mac OS", "Chrome", "114.0.5735.198"] 
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        if (db) {
            try {
                const creds = JSON.parse(fs.readFileSync('./auth_info/creds.json'));
                await db.collection('session').doc('whatsapp').set(creds);
            } catch (e) { console.log("خطأ في حفظ البيانات:", e.message); }
        }
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, qr } = update;
        if (qr) QRCode.toDataURL(qr, (err, url) => { qrCodeImage = url; });
        if (connection === 'open') { qrCodeImage = "DONE"; console.log("✅ متصل الآن!"); }
        if (connection === 'close') startBot();
    });

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.key.fromMe && msg.message) {
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
            if (!text) return;

            let responseText = "";

            // المحاولة 1: Groq (الأساسي)
            try {
                const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
                const completion = await groq.chat.completions.create({
                    messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: text }],
                    model: "llama-3.3-70b-versatile",
                });
                responseText = completion.choices[0].message.content;
            } catch (e) {
                console.log("⚠️ فشل Groq، محاولة Gemini...");
                // المحاولة 2: Gemini (الاحتياطي الأول)
                try {
                    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
                    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
                    const result = await model.generateContent(SYSTEM_PROMPT + "\n\nالمستخدم يقول: " + text);
                    responseText = result.response.text();
                } catch (e2) {
                    console.log("⚠️ فشل Gemini، محاولة Mistral...");
                    // المحاولة 3: Mistral (الاحتياطي النهائي)
                    try {
                        const mistral = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });
                        const res = await mistral.chat.complete({
                            model: "mistral-small-latest",
                            messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: text }],
                        });
                        responseText = res.choices[0].message.content;
                    } catch (e3) { console.log("❌ جميع المحركات فشلت"); }
                }
            }

            if (responseText) {
                await sock.sendMessage(msg.key.remoteJid, { text: responseText });
            }
        }
    });
}

app.get("/", (req, res) => {
    res.setHeader('Refresh', '8');
    if (qrCodeImage === "DONE") return res.send("<h1>✅ متصل والذاكرة مفعّلة!</h1>");
    if (qrCodeImage) return res.send(`<h1>امسح الرمز:</h1><br><img src="${qrCodeImage}" style="width:300px; border: 5px solid #000;"/>`);
    res.send("<h1>جاري الاتصال...</h1>");
});

app.listen(port, () => { startBot(); });
