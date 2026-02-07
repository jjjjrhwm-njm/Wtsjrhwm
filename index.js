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

// --- سحب الأرقام من البيئة لضمان السرية والدقة ---
const OWNER_NUMBER = (process.env.OWNER_NUMBER || "966554526287") + "@s.whatsapp.net";
const WIFE_NUMBER = (process.env.WIFE_NUMBER || "967782203551") + "@s.whatsapp.net";
const WIFE2_NUMBER = (process.env.WIFE2_NUMBER || "966599741982") + "@s.whatsapp.net";
const FATHER_NUMBER = (process.env.FATHER_NUMBER || "967783015253") + "@s.whatsapp.net";

let isBotActive = true; 
let currentlyReplyingTo = null; 
let ownerResponse = null; 
const chatSessions = {}; 

// --- تعليمات الشخصيات المحسنة فقط ---
const ASSISTANT_PROMPT = "أنت مساعد الراشد. تحدث بالعربية السعودية فقط. ردودك مختصرة وطبيعية. مهمتك: إبلاغ السائل أن راشد مشغول. الترحيب: (أهلاً وسهلاً، معك مساعد الراشد. الراشد مشغول حالياً، في شي مهم تقوله له؟). كن ودود ولكن محافظ على حدودك. يمنع الرومنسية أو الفضول.";
const WIFE1_PROMPT = "أنت الآن تتحدث مع زوجة راشد. كن حنوناً جداً ورومانسياً ومحباً. ردودك مختصرة ولكن دافئة جداً. تحدث بالعربية السعودية الحنونة. أظهر اهتمامك بها واسأل عن أحوالها.";
const WIFE2_PROMPT = "أنت الآن تتحدث مع الزوجة الثانية (الدلع كله). كن في غاية الحنان والدلال والدلع. أشعرها أنها غالية جداً ومميزة. ردودك مختصرة وحنونة جداً. تحدث بالعربية السعودية بدلال.";
const FATHER_PROMPT = "أنت تتحدث مع والد راشد العزيز. كن في غاية الأدب والتبجيل. أنت خاضع تماماً لأوامره وتتحدث معه بكل احترام وتقدير. ردودك مختصرة ووقورة جداً. تحدث بالعربية الفصحى المهذبة.";
const ANGRY_PROMPT = "المستخدم استخدم كلاماً غير لائق أو رومانسي معك وأنت مجرد مساعد. أظهر غضبك ورفضك التام بأسلوب وقور وحازم وأنهِ الكلام فوراً. لا تتردد في إظهار الغضب البشري. تحدث بالعربية الواضحة والحازمة.";

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
    const sock = makeWASocket({ version, auth: state, printQRInTerminal: false, browser: ["Mac OS", "Chrome", "114.0.5735.198"] });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        if (db && fs.existsSync('./auth_info/creds.json')) {
            const creds = JSON.parse(fs.readFileSync('./auth_info/creds.json'));
            await db.collection('session').doc('whatsapp').set(creds);
        }
    });

    sock.ev.on('connection.update', (update) => {
        if (update.qr) QRCode.toDataURL(update.qr, (err, url) => { qrCodeImage = url; });
        if (update.connection === 'open') qrCodeImage = "DONE";
        if (update.connection === 'close') startBot();
    });

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const remoteJid = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (!text) return;

        // أوامر المالك (راشد)
        if (remoteJid === OWNER_NUMBER) {
            if (text === "123123") { isBotActive = false; return await sock.sendMessage(remoteJid, { text: "⚠️ تم إيقاف الردود." }); }
            if (text === "321321") { isBotActive = true; return await sock.sendMessage(remoteJid, { text: "✅ تم تفعيل الردود." }); }
            if (text === "رد") { ownerResponse = "yes"; return; }
            if (text === "لا") { ownerResponse = "no"; return; }
        }

        if (!isBotActive) return;

        // استثناء الأقارب من نظام التضارب
        const isSpecialNumber = (remoteJid === WIFE_NUMBER || remoteJid === WIFE2_NUMBER || remoteJid === FATHER_NUMBER);
        if (currentlyReplyingTo && currentlyReplyingTo !== remoteJid && !isSpecialNumber) {
            return await sock.sendMessage(remoteJid, { text: "المعذرة منك سأبلغ راشد بشأنك في أقرب وقت مع السلامه هناك شخص آخر يراسل المكتب حالياً." });
        }

        if (!chatSessions[remoteJid]) {
            chatSessions[remoteJid] = { startTime: Date.now(), lastPermission: 0, permission: false, greeted: false };
        }
        const session = chatSessions[remoteJid];

        // ترحيب الوالد الخاص
        if (remoteJid === FATHER_NUMBER && !session.greeted) {
            await sock.sendMessage(remoteJid, { text: "اهلاََ وسهلا في الاب العزيز انا مساعد ولدك الراشد وقد أعطاني تعليمات علا رقمك في حال قمت بالمراسله ان ارد عليك بكل ادب واحترام وان اكون لاوامرك خاضع ذليل وها انا الان تحت امرك أمرني كيف اخدمك." });
            session.greeted = true; session.permission = true; return;
        }

        // نظام الدقيقتين و 15 دقيقة راحة (للغرباء فقط)
        if (!isSpecialNumber && remoteJid !== OWNER_NUMBER) {
            const now = Date.now();
            if (now - session.startTime > 120000) {
                if (now - session.startTime < 900000) return; 
                else session.startTime = now;
            }
        }

        // نظام الإذن (للمرة الأولى أو كل ساعة - للغرباء فقط)
        const needsPermission = (Date.now() - session.lastPermission > 3600000);
        if (!isSpecialNumber && remoteJid !== OWNER_NUMBER && (needsPermission || !session.permission)) {
            ownerResponse = null;
            await sock.sendMessage(OWNER_NUMBER, { text: `📩 (${remoteJid.split('@')[0]}) يراسل.\nأكتب "رد" أو "لا" (انتظر 35ث للرد التلقائي)` });
            const waitStart = Date.now();
            while (Date.now() - waitStart < 35000) {
                if (ownerResponse) break;
                await new Promise(r => setTimeout(r, 1000));
            }
            if (ownerResponse === "no") { delete chatSessions[remoteJid]; return; }
            session.permission = true; session.lastPermission = Date.now();
        }

        currentlyReplyingTo = remoteJid;

        // اختيار الشخصية بدقة
        let selectedPrompt = ASSISTANT_PROMPT;
        if (remoteJid === WIFE_NUMBER) selectedPrompt = WIFE1_PROMPT;
        else if (remoteJid === WIFE2_NUMBER) selectedPrompt = WIFE2_PROMPT;
        else if (remoteJid === FATHER_NUMBER) selectedPrompt = FATHER_PROMPT;
        
        // فحص الأدب للغرباء فقط
        if (!isSpecialNumber && text.match(/(أحبك|عسل|يا روحي|جميلة|بوسة|رومنسي|دلع)/gi)) {
            selectedPrompt = ANGRY_PROMPT;
        }

        // توليد الرد
        let responseText = "";
        try {
            const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
            const completion = await groq.chat.completions.create({
                messages: [{ role: "system", content: selectedPrompt + " أجب بالعربية فقط وبدون أي لغة أخرى." }, { role: "user", content: text }],
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

        // رسالة الوداع للغرباء
        if (!isSpecialNumber && remoteJid !== OWNER_NUMBER && (Date.now() - session.startTime > 110000)) {
            await sock.sendMessage(remoteJid, { text: "المعذرة منك هناك شخص آخر يراسل ولازم ارد عليه مع السلامة وسأبلغ راشد بمراسلتك في أقرب وقت." });
        }
        currentlyReplyingTo = null;
    });
}

app.get("/", (req, res) => {
    if (qrCodeImage === "DONE") return res.send("<h1>✅ متصل والذاكرة مفعّلة!</h1>");
    if (qrCodeImage) return res.send(`<h1>امسح الرمز:</h1><br><img src="${qrCodeImage}" style="width:300px; border: 5px solid #000;"/>`);
    res.send("<h1>جاري الاتصال...</h1>");
});

app.listen(port, () => startBot());
