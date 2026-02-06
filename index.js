const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion,
    delay 
} = require("@whiskeysockets/baileys");
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
let sock;

// --- إعدادات الأرقام ---
const OWNER_NUMBER = (process.env.OWNER_NUMBER || "966554526287") + "@s.whatsapp.net";
const WIFE_NUMBER = (process.env.WIFE_NUMBER || "967782203551") + "@s.whatsapp.net";
const WIFE2_NUMBER = (process.env.WIFE2_NUMBER || "966599741982") + "@s.whatsapp.net";
const FATHER_NUMBER = (process.env.FATHER_NUMBER || "967783015253") + "@s.whatsapp.net";

let isBotActive = true; 
let currentlyReplyingTo = null; 
let ownerResponses = {};
const chatSessions = {}; 

// --- ستايل سعودي بشري ---
const GLOBAL_STYLE = `
أنت إنسان حقيقي تتكلم بلهجة سعودية.
ممنوع استخدام أي كلمة إنجليزية.
تكلم بأسلوب واتساب طبيعي.
لا تكرر كلام المستخدم.
ردودك قصيرة وبشرية.
لا تقول أنك روبوت أو نظام.
تصرف كأنك شخص واقعي.
`;

// --- تعليمات الشخصيات ---
const ASSISTANT_PROMPT = `
أنت مساعد راشد.
أسلوبك سعودي هادي وبشري.
تخبر أن راشد مشغول بطريقة لطيفة.
`;

const WIFE_PROMPT = `
أنت زوج راشد.
كلامك حنون وقريب من القلب.
دلع بسيط بدون مبالغة.
أسلوب سعودي طبيعي.
`;

const WIFE2_PROMPT = `
أنت قريب جداً منها.
اهتمام ودلع بأسلوب سعودي ناعم.
كأنك شخص حقيقي.
`;

const FATHER_PROMPT = `
أنت تخاطب والد راشد.
احترام وأدب سعودي عالي.
كأنك ابن يتكلم مع والده.
`;

const ANGRY_PROMPT = `
المستخدم أساء الأدب.
ترد بحزم سعودي محترم وباختصار وتنهي الكلام.
`;

// إعداد Firebase
if (process.env.FIREBASE_CONFIG) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
        if (!admin.apps.length) {
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
            db = admin.firestore();
            console.log("✅ تم ربط Firebase");
        }
    } catch (e) { console.error("❌ خطأ في Firebase Config"); }
}

async function startBot() {
    const sessionFolder = './whatsapp_auth_v3';
    if (!fs.existsSync(sessionFolder)) fs.mkdirSync(sessionFolder);

    // استعادة الجلسة من Firebase قبل البدء
    if (db) {
        try {
            const doc = await db.collection('session').doc('whatsapp').get();
            if (doc.exists) {
                const data = doc.data();
                if (!fs.existsSync(`${sessionFolder}/creds.json`)) {
                    fs.writeFileSync(`${sessionFolder}/creds.json`, JSON.stringify(data));
                    console.log("📂 تم استعادة الجلسة من السحابة");
                }
            }
        } catch (e) { console.log("⚠️ فشل استعادة الجلسة"); }
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
    const { version } = await fetchLatestBaileysVersion();
    
    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        browser: ["Rashed Bot", "Chrome", "1.0.0"] 
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        if (db) {
            try {
                const creds = JSON.parse(fs.readFileSync(`${sessionFolder}/creds.json`));
                await db.collection('session').doc('whatsapp').set(creds);
            } catch (e) { console.log("❌ فشل تحديث Firebase"); }
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;
        if (qr) QRCode.toDataURL(qr, (err, url) => { qrCodeImage = url; });
        
        if (connection === 'open') {
            qrCodeImage = "DONE";
            console.log("✅ متصل الآن بنجاح!");
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log("🔄 انقطع الاتصال، السبب:", lastDisconnect?.error, "إعادة الاتصال:", shouldReconnect);
            if (shouldReconnect) startBot();
            else {
                console.log("❌ تم تسجيل الخروج. يرجى مسح QR جديد.");
                if (fs.existsSync(sessionFolder)) fs.rmSync(sessionFolder, { recursive: true, force: true });
            }
        }
    });

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const remoteJid = msg.key.remoteJid;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
        if (!text) return;

        // --- أوامر المالك ---
        if (remoteJid === OWNER_NUMBER) {
            if (text === "123123") { isBotActive = false; return await sock.sendMessage(remoteJid, { text: "⚠️ تم إيقاف الردود الآلية." }); }
            if (text === "321321") { isBotActive = true; return await sock.sendMessage(remoteJid, { text: "✅ تم تفعيل الردود الآلية." }); }
            if (text === "رد") { ownerResponses[currentlyReplyingTo] = "yes"; return; }
            if (text === "لا") { ownerResponses[currentlyReplyingTo] = "no"; return; }
        }

        if (!isBotActive) return;

        if (!chatSessions[remoteJid]) {
            chatSessions[remoteJid] = { startTime: Date.now(), lastPermissionTime: 0, permissionGranted: false, fatherGreeted: false };
        }
        const session = chatSessions[remoteJid];

        // --- تعامل خاص مع الوالد ---
        if (remoteJid === FATHER_NUMBER && !session.fatherGreeted) {
            await sock.sendMessage(remoteJid, { text: "ياهلا وغلا يابوي، أنا موجود تحت أمرك." });
            session.fatherGreeted = true;
            session.permissionGranted = true;
            return; 
        }

        // --- معالجة الرد بالذكاء الاصطناعي ---
        try {
            let selectedPrompt = ASSISTANT_PROMPT;
            if (remoteJid === WIFE_NUMBER) selectedPrompt = WIFE_PROMPT;
            else if (remoteJid === WIFE2_NUMBER) selectedPrompt = WIFE2_PROMPT;
            else if (remoteJid === FATHER_NUMBER) selectedPrompt = FATHER_PROMPT;
            else if (text.match(/(سب|لعن|قليل ادب)/gi)) selectedPrompt = ANGRY_PROMPT;

            let responseText = "";

            const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
            const completion = await groq.chat.completions.create({
                messages: [
                    { role: "system", content: GLOBAL_STYLE + selectedPrompt },
                    { role: "user", content: text }
                ],
                model: "llama-3.3-70b-versatile",
            });

            responseText = completion.choices[0].message.content.trim();

            if (responseText) {
                await sock.sendMessage(remoteJid, { text: responseText });
            }

        } catch (error) {
            console.error("AI Error:", error);
        }
    });
}

// واجهة الويب
app.get("/", (req, res) => {
    if (qrCodeImage === "DONE") return res.send("<h1 style='color:green;'>✅ البوت متصل</h1>");
    if (qrCodeImage) return res.send(`<img src="${qrCodeImage}" style="width:300px"/>`);
    res.send("جاري التشغيل...");
});

// تشغيل السيرفر
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    startBot().catch(err => console.error("StartBot Error:", err));
});
