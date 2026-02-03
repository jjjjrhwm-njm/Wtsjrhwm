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

// --- متغيرات الحالة (التحكم) ---
const OWNER_NUMBER = "966554526287@s.whatsapp.net";
let isBotActive = true; 
let currentActiveChat = null; // لمتابعة الشخص الذي يراسل حالياً
let ownerResponse = null; 

// تعليمات الشخصية المحدثة (سكرتير نجم الإبداع المراوغ)
const SYSTEM_PROMPT = "أنت سكرتير راشد (نجم الإبداع). ردودك مختصرة جداً ووقورة. وظيفتك الأساسية هي جعل السائل يشعر أن راشد مشغول جداً في مشاريع ضخمة حالياً ولا يمكنه الرد بنفسه. راوغ في الإجابات ولا تعطي تفاصيل، فقط قل أنك ستبلغه. يمنع الرومنسية أو أي خروج عن الآداب العامة.";

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
        if (!msg.message) return;

        const remoteJid = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (!text) return;

        // --- ١. أوامر المالك (راشد) ---
        if (remoteJid === OWNER_NUMBER || msg.key.fromMe) {
            if (text === "123123") {
                isBotActive = false;
                await sock.sendMessage(remoteJid, { text: "⚠️ تم إيقاف ردود البوت نهائياً." });
                return;
            }
            if (text === "321321") {
                isBotActive = true;
                await sock.sendMessage(remoteJid, { text: "✅ تم تفعيل ردود البوت." });
                return;
            }
            if (text === "رد") { ownerResponse = "yes"; return; }
            if (text === "لا") { ownerResponse = "no"; return; }
        }

        // إذا كان البوت مطفأ أو الرسالة من البوت نفسه، لا تفعل شيئاً
        if (!isBotActive || msg.key.fromMe) return;

        // --- ٢. منطق التضارب (شخص آخر يراسل) ---
        if (currentActiveChat && currentActiveChat !== remoteJid) {
            await sock.sendMessage(remoteJid, { text: "المعذرة، سأبلغ راشد بشأنك في أقرب وقت. هناك شخص آخر يراسل المكتب حالياً.. مع السلامة." });
            return;
        }

        // --- ٣. نظام الإذن والانتظار (35 ثانية) ---
        currentActiveChat = remoteJid;
        ownerResponse = null;

        // إشعار المالك (أنت)
        await sock.sendMessage(OWNER_NUMBER, { text: `📩 فلان (${remoteJid.split('@')[0]}) يراسل راشد الآن.\nأكتب "رد" للموافقة، "لا" للمنع، أو انتظر 35 ثانية ليرد البوت تلقائياً.` });

        // عداد الانتظار
        const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
        for (let i = 0; i < 35; i++) {
            if (ownerResponse) break;
            await wait(1000);
        }

        // التحقق من قرار المالك
        if (ownerResponse === "no") {
            currentActiveChat = null;
            return;
        }

        // --- ٤. توليد الرد (AI Failover) ---
        let responseText = "";
        try {
            const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
            const completion = await groq.chat.completions.create({
                messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: text }],
                model: "llama-3.3-70b-versatile",
            });
            responseText = completion.choices[0].message.content;
        } catch (e) {
            try {
                const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
                const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
                const result = await model.generateContent(SYSTEM_PROMPT + "\n\nالمستخدم: " + text);
                responseText = result.response.text();
            } catch (e2) {
                try {
                    const mistral = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });
                    const res = await mistral.chat.complete({
                        model: "mistral-small-latest",
                        messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: text }],
                    });
                    responseText = res.choices[0].message.content;
                } catch (e3) { console.log("فشلت المحركات"); }
            }
        }

        if (responseText) {
            await sock.sendMessage(remoteJid, { text: responseText });
        }
        
        // تحرير الحالة بعد الرد
        currentActiveChat = null;
    });
}

app.get("/", (req, res) => {
    res.setHeader('Refresh', '8');
    if (qrCodeImage === "DONE") return res.send("<h1>✅ متصل والذاكرة مفعّلة!</h1>");
    if (qrCodeImage) return res.send(`<h1>امسح الرمز:</h1><br><img src="${qrCodeImage}" style="width:300px; border: 5px solid #000;"/>`);
    res.send("<h1>جاري الاتصال...</h1>");
});

app.listen(port, () => { startBot(); });
