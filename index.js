const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, jidNormalizedUser } = require("@whiskeysockets/baileys");
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

// --- تنظيف الأرقام لضمان التعرف الدقيق ---
const formatNumber = (num) => num.replace(/\D/g, '') + "@s.whatsapp.net";
const OWNER_NUMBER = formatNumber(process.env.OWNER_NUMBER || "966554526287");
const WIFE_NUMBER = formatNumber(process.env.WIFE_NUMBER || "967782203551");
const WIFE2_NUMBER = formatNumber(process.env.WIFE2_NUMBER || "966599741982");
const FATHER_NUMBER = formatNumber(process.env.FATHER_NUMBER || "967783015253");

let isBotActive = true;
let currentlyReplyingTo = null;
const chatSessions = {}; 

// --- تعليمات الشخصيات الصارمة (أسلوب بشري) ---
const SYSTEM_PROMPTS = {
    assistant: "أنت مساعد راشد الشخصي. ردودك مختصرة جداً (سطر واحد). إذا كانت هذه أول رسالة، عرف بنفسك بذكاء. إذا كانت محادثة مستمرة، ادخل في الموضوع فوراً. راشد مشغول حالياً. لا تكرر اسمك أبداً.",
    wife: "أنت راشد. تحدث مع زوجتك بحب ودلال واختصار شديد (هلا يا قلبي، أبشري، شوي وأكلمك). كن إنساناً حقيقياً.",
    father: "أنت راشد. والدك يراسل الآن. كن في قمة الأدب (سمّ يا غالي، أبشر من عيوني، تأمرني أمر).",
    angry: "أنت مساعد راشد. هذا الشخص غير مؤدب. رد عليه بكلمتين حازمتين وأنهِ المحادثة فوراً."
};

if (process.env.FIREBASE_CONFIG) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
        if (!admin.apps.length) {
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
            db = admin.firestore();
            console.log("✅ تم ربط الخزنة بنجاح");
        }
    } catch (e) { console.log("❌ خطأ Firebase"); }
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({ version, auth: state, printQRInTerminal: false, browser: ["Rashed Office", "Chrome", "1.0.0"] });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        if (update.qr) QRCode.toDataURL(update.qr, (err, url) => { qrCodeImage = url; });
        if (update.connection === 'open') qrCodeImage = "DONE";
        if (update.connection === 'close') startBot();
    });

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const jid = jidNormalizedUser(msg.key.remoteJid);
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (!text) return;

        // أوامر المالك (راشد)
        if (jid === OWNER_NUMBER) {
            if (text === "123123") { isBotActive = false; return await sock.sendMessage(jid, { text: "⚠️ تم إيقاف المساعد." }); }
            if (text === "321321") { isBotActive = true; return await sock.sendMessage(jid, { text: "✅ المساعد يعمل الآن." }); }
            return;
        }

        if (!isBotActive) return;

        // تهيئة الجلسة والذاكرة
        if (!chatSessions[jid]) {
            chatSessions[jid] = { 
                startTime: Date.now(), 
                history: [], 
                greeted: false,
                permission: (jid === WIFE_NUMBER || jid === WIFE2_NUMBER || jid === FATHER_NUMBER) 
            };
        }
        const session = chatSessions[jid];

        // التعرف على الشخصية
        let role = "assistant";
        if (jid === WIFE_NUMBER || jid === WIFE2_NUMBER) role = "wife";
        else if (jid === FATHER_NUMBER) role = "father";
        
        // نظام الأدب للغرباء
        if (role === "assistant" && text.match(/(أحبك|يا عسل|يا روحي|بوسة)/gi)) role = "angry";

        // منع التضارب (إدارة السكرتارية)
        if (currentlyReplyingTo && currentlyReplyingTo !== jid && role === "assistant") {
            return await sock.sendMessage(jid, { text: "المعذرة، أرد على مراجع آخر حالياً وسأبلغ راشد بمراسلتك فوراً." });
        }

        currentlyReplyingTo = jid;
        await sock.sendPresenceUpdate('composing', jid); // لمسة إبداعية: إظهار جاري الكتابة

        // بناء الطلب للذكاء الاصطناعي مع السياق
        const historyContext = session.history.slice(-3).map(h => h.content).join("\n");
        const instruction = session.greeted ? "أجب مباشرة بدون تعريف بنفسك." : "عرف بنفسك كمساعد لراشد لأول مرة فقط.";
        
        const finalPrompt = `${SYSTEM_PROMPTS[role]}\n${instruction}\nالسياق السابق:\n${historyContext}\nالمستخدم يقول: ${text}`;

        let responseText = "";
        try {
            const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
            const completion = await groq.chat.completions.create({
                messages: [{ role: "system", content: finalPrompt }],
                model: "llama-3.3-70b-versatile",
            });
            responseText = completion.choices[0].message.content;
        } catch (e) {
            const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
            const result = await model.generateContent(finalPrompt);
            responseText = result.response.text();
        }

        if (responseText) {
            // تنظيف الرد من علامات الاقتباس ليكون بشرياً
            responseText = responseText.replace(/["']/g, ""); 
            await sock.sendMessage(jid, { text: responseText });
            
            // تحديث حالة الجلسة
            session.greeted = true;
            session.history.push({ role: "user", content: text }, { role: "assistant", content: responseText });
        }

        currentlyReplyingTo = null;
    });
}

app.get("/", (req, res) => {
    if (qrCodeImage === "DONE") return res.send("<h1>✅ السكرتير متصل الآن</h1>");
    if (qrCodeImage) return res.send(`<h1>امسح الرمز:</h1><br><img src="${qrCodeImage}"/>`);
    res.send("<h1>جاري الاتصال...</h1>");
});

app.listen(port, () => startBot());
