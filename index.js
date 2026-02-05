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

// --- إعدادات الهوية (تنظيف الأرقام لضمان الدقة) ---
const formatNumber = (num) => num.replace(/\D/g, '') + "@s.whatsapp.net";
const OWNER_NUMBER = formatNumber(process.env.OWNER_NUMBER || "966554526287");
const WIFE_NUMBER = formatNumber(process.env.WIFE_NUMBER || "967782203551");
const WIFE2_NUMBER = formatNumber(process.env.WIFE2_NUMBER || "966599741982");
const FATHER_NUMBER = formatNumber(process.env.FATHER_NUMBER || "967783015253");

let isBotActive = true;
let currentlyReplyingTo = null;
const chatSessions = {}; // تخزين الذاكرة والمؤقتات

// --- محرك الشخصيات المتطور ---
const SYSTEM_CONFIG = {
    assistant: "أنت 'مساعد راشد الشخصي'. ذكي، لبق، ومختصر جداً. راشد الآن في اجتماع عمل ولا يمكنه الرد. مهمتك امتصاص حماس المتصل، أخذ الرسالة منه، ووعده بأن راشد سيعاوده الاتصال. لا تكرر نفسك. إذا سألك من أنت، قل أنا مساعده الرقمي.",
    wife: "أنت راشد الآن. تحدث مع زوجتك بكل حب، دلال، وعاطفة. استخدم كلمات دافئة (حياتي، قلبي، يا أغلى ما عندي). اجعلها تشعر أنها الأولوية رغم انشغالك.",
    father: "أنت راشد. تحدث مع والدك بأعلى درجات التبجيل والطاعة. استخدم عبارات (أبشر، سمّ، تأمرني، يا غالي). أنت خاضع تماماً لأوامره.",
    angry: "أنت مساعد راشد. هذا المستخدم يتجاوز حدوده أو يستخدم ألفاظاً غير لائقة. رد بحزم ووقار وأنهِ المحادثة فوراً. لا تسمح بالتمادي."
};

// --- إعداد Firebase ---
if (process.env.FIREBASE_CONFIG) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
        if (!admin.apps.length) {
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
            db = admin.firestore();
        }
    } catch (e) { console.error("❌ Firebase Error"); }
}

// --- دالة الذكاء الاصطناعي مع الذاكرة ---
async function getAIResponse(jid, userText, promptType) {
    const session = chatSessions[jid];
    // بناء سياق المحادثة (آخر 5 رسائل)
    const context = session.history.map(h => `${h.role === 'user' ? 'السائل' : 'أنت'}: ${h.content}`).join("\n");
    
    const fullPrompt = `${SYSTEM_CONFIG[promptType]}\n\nالسياق السابق:\n${context}\n\nالسائل الآن يقول: ${userText}\nردك (بالعربية فقط، مختصر، وبشري جداً):`;

    try {
        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
        const completion = await groq.chat.completions.create({
            messages: [{ role: "system", content: fullPrompt }],
            model: "llama-3.3-70b-versatile",
        });
        return completion.choices[0].message.content;
    } catch (e) {
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const result = await model.generateContent(fullPrompt);
        return result.response.text();
    }
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();
    
    sock = makeWASocket({ 
        version, 
        auth: state, 
        printQRInTerminal: false,
        browser: ["Rashed Assistant", "Chrome", "1.0.0"]
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) QRCode.toDataURL(qr, (err, url) => { qrCodeImage = url; });
        if (connection === 'open') { qrCodeImage = "DONE"; console.log("✅ المتصل الآن: راشد"); }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        }
    });

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const jid = jidNormalizedUser(msg.key.remoteJid);
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
        
        if (!text) return;

        // التحكم عن بعد (راشد)
        if (jid === OWNER_NUMBER) {
            if (text === "123123") { isBotActive = false; return sock.sendMessage(jid, { text: "📴 تم إيقاف المساعد." }); }
            if (text === "321321") { isBotActive = true; return sock.sendMessage(jid, { text: "🔛 المساعد في الخدمة الآن." }); }
            return; 
        }

        if (!isBotActive) return;

        // تهيئة الجلسة إذا كانت جديدة
        if (!chatSessions[jid]) {
            chatSessions[jid] = { 
                history: [], 
                lastActive: Date.now(), 
                permission: (jid === WIFE_NUMBER || jid === WIFE2_NUMBER || jid === FATHER_NUMBER) 
            };
        }
        
        const session = chatSessions[jid];
        session.lastActive = Date.now();

        // منطق التعامل مع الغرباء (طلب الإذن)
        if (!session.permission) {
            await sock.sendMessage(OWNER_NUMBER, { text: `🔔 مستخدم جديد يحاول التواصل: \nwa.me/${jid.split('@')[0]}\nالرسالة: ${text}\n\n(سأنتظر 30 ثانية قبل الرد التلقائي)` });
            
            // انتظار بشري (Non-blocking)
            const approved = await waitForOwner(jid);
            if (!approved) return; 
            session.permission = true;
        }

        // تحديد الشخصية
        let role = "assistant";
        if (jid === WIFE_NUMBER) role = "wife";
        else if (jid === WIFE2_NUMBER) role = "wife"; // أو wife2 حسب الرغبة
        else if (jid === FATHER_NUMBER) role = "father";
        
        // كشف قلة الأدب
        if (role === "assistant" && text.match(/(احبك|يا عمري|بوسه|تعال|كلمني رومانسي)/gi)) role = "angry";

        // منع التضارب
        if (currentlyReplyingTo && currentlyReplyingTo !== jid && role === "assistant") {
            return sock.sendMessage(jid, { text: "أعتذر منك جداً، أنا أرد على مكالمة أخرى تخص المكتب الآن. سأكلمك فور انتهائي." });
        }

        currentlyReplyingTo = jid;
        sock.sendPresenceUpdate('composing', jid); // إظهار "جاري الكتابة" لمزيد من الواقعية

        const aiResponse = await getAIResponse(jid, text, role);
        
        // تحديث الذاكرة
        session.history.push({ role: "user", content: text });
        session.history.push({ role: "assistant", content: aiResponse });
        if (session.history.length > 10) session.history.shift();

        await sock.sendMessage(jid, { text: aiResponse });
        currentlyReplyingTo = null;
    });
}

// دالة ذكية لانتظار رد راشد دون تعليق النظام
function waitForOwner(userJid) {
    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            resolve(true); // إذا لم يرد راشد خلال 30 ثانية، يبدأ المساعد بالعمل تلقائياً
        }, 30000);

        // هنا يمكن إضافة logic إذا كتب راشد "لا" يلغي التواصل
    });
}

app.get("/", (req, res) => {
    if (qrCodeImage === "DONE") return res.send("<body style='background:#d4edda; text-align:center;'><h1>✅ السكرتير يعمل بنجاح!</h1></body>");
    if (qrCodeImage) return res.send(`<body style='text-align:center;'><h1>امسح الرمز لتفعيل السكرتير</h1><img src="${qrCodeImage}" /></body>`);
    res.send("<h1>جاري التحميل...</h1>");
});

app.listen(port, () => startBot());
