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

// --- إعدادات الأرقام والحالات ---
const OWNER_NUMBER = "966554526287@s.whatsapp.net";
const WIFE_NUMBER = "967782203551@s.whatsapp.net";
const EXEMPT_NUMBER = "966554526287@s.whatsapp.net"; // الرقم المستثنى من وقت الدقيقتين

let isBotActive = true; 
let currentlyReplyingTo = null; // لمتابعة المحادثة النشطة حالياً
let ownerResponse = null; 
const chatSessions = {}; // تخزين بيانات المحادثات (الوقت، الإذن)

// --- تعليمات الشخصيات (Prompts) ---
const ASSISTANT_PROMPT = "أهلاً بك، معك مساعد الراشد. راشد مشغول الآن، هل هناك شيء مهم أخبرني به وسأوصله للراشد في أقرب وقت. ردودك مختصره، وقورة، ومهنية. حسس السائل أن راشد شخص مهم جداً.";
const WIFE_PROMPT = "أنت الآن تتحدث مع زوجة راشد (الغالية). كن حنوناً جداً، رومانسياً، وكلامك كله حب وعاطفة واشتياق. أنت تمثل مشاعر راشد تجاهها فقط.";
const ANGRY_PROMPT = "المستخدم استخدم كلاماً غير لائق أو رومانسي معك وأنت مجرد مساعد. أظهر غضبك ورفضك التام بأسلوب حازم وأنهِ الكلام فوراً.";

// إعداد الخزنة (Firebase)
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
    
    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        browser: ["Mac OS", "Chrome", "114.0.5735.198"] 
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, qr } = update;
        if (qr) QRCode.toDataURL(qr, (err, url) => { qrCodeImage = url; });
        if (connection === 'open') qrCodeImage = "DONE";
        if (connection === 'close') startBot();
    });

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const remoteJid = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (!text) return;

        // --- ١. أوامر التحكم (راشد) ---
        if (remoteJid === OWNER_NUMBER) {
            if (text === "123123") { isBotActive = false; return await sock.sendMessage(remoteJid, { text: "⚠️ تم إيقاف الردود." }); }
            if (text === "321321") { isBotActive = true; return await sock.sendMessage(remoteJid, { text: "✅ تم تفعيل الردود." }); }
            if (text === "رد") { ownerResponse = "yes"; return; }
            if (text === "لا") { ownerResponse = "no"; return; }
        }

        if (!isBotActive) return;

        // --- ٢. منطق التضارب (Busy System) ---
        if (currentlyReplyingTo && currentlyReplyingTo !== remoteJid && remoteJid !== WIFE_NUMBER) {
            return await sock.sendMessage(remoteJid, { text: "المعذرة منك، سأبلغ راشد بشأنك في أقرب وقت.. هناك شخص آخر يراسل المكتب حالياً، مع السلامة." });
        }

        // إعداد بيانات الجلسة
        if (!chatSessions[remoteJid]) {
            chatSessions[remoteJid] = { startTime: Date.now(), lastActive: 0, permission: false };
        }
        const session = chatSessions[remoteJid];

        // --- ٣. نظام الدقيقتين و 15 دقيقة راحة ---
        if (remoteJid !== WIFE_NUMBER && remoteJid !== EXEMPT_NUMBER) {
            const timePassed = Date.now() - session.startTime;
            if (timePassed > 120000) { // دقيقتين
                if (timePassed < 900000) { // أقل من 15 دقيقة
                    return; // صمت حتى تنتهي فترة الراحة
                } else {
                    session.startTime = Date.now(); // إعادة ضبط بعد 15 دقيقة
                }
            }
        }

        // --- ٤. نظام الإذن (مرة كل ساعة) ---
        const needsPermission = (Date.now() - session.lastActive > 3600000);
        if ((needsPermission || !session.permission) && remoteJid !== WIFE_NUMBER) {
            ownerResponse = null;
            await sock.sendMessage(OWNER_NUMBER, { text: `📩 (${remoteJid.split('@')[0]}) يراسل الآن.\n"رد" أو "لا"؟ (انتظر 35ث للرد التلقائي)` });
            
            const startWait = Date.now();
            while (Date.now() - startWait < 35000) {
                if (ownerResponse) break;
                await new Promise(r => setTimeout(r, 1000));
            }

            if (ownerResponse === "no") { delete chatSessions[remoteJid]; return; }
            session.permission = true;
            session.lastActive = Date.now();
        }

        currentlyReplyingTo = remoteJid;
        session.lastActive = Date.now();

        // --- ٥. اختيار الشخصية وفحص الأدب ---
        let selectedPrompt = ASSISTANT_PROMPT;
        if (remoteJid === WIFE_NUMBER) {
            selectedPrompt = WIFE_PROMPT;
        } else if (text.match(/(أحبك|عسل|يا روحي|جميلة|بوسة)/gi)) {
            selectedPrompt = ANGRY_PROMPT;
        }

        // --- ٦. توليد الرد (AI) ---
        let responseText = "";
        try {
            const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
            const completion = await groq.chat.completions.create({
                messages: [{ role: "system", content: selectedPrompt }, { role: "user", content: text }],
                model: "llama-3.3-70b-versatile",
            });
            responseText = completion.choices[0].message.content;
        } catch (e) {
            const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
            const result = await model.generateContent(selectedPrompt + "\nالمستخدم: " + text);
            responseText = result.response.text();
        }

        if (responseText) await sock.sendMessage(remoteJid, { text: responseText });

        // إذا انتهت الدقيقتين في هذه الرسالة
        if (remoteJid !== WIFE_NUMBER && remoteJid !== EXEMPT_NUMBER && (Date.now() - session.startTime > 110000)) {
            await sock.sendMessage(remoteJid, { text: "المعذرة منك هناك شخص آخر يراسل ولازم ارد عليه مع السلامة وسأبلغ راشد بمراسلتك في أقرب وقت." });
        }

        currentlyReplyingTo = null;
    });
}

app.get("/", (req, res) => {
    if (qrCodeImage === "DONE") return res.send("<h1>✅ متصل والذاكرة مفعّلة!</h1>");
    if (qrCodeImage) return res.send(`<h1>امسح الرمز:</h1><br><img src="${qrCodeImage}" style="width:300px;"/>`);
    res.send("<h1>جاري الاتصال...</h1>");
});

app.listen(port, () => startBot());
