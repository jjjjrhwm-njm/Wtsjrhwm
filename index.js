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
let ownerResponses = {}; // لتخزين ردود المالك لكل رقم بشكل منفصل
const chatSessions = {}; 

// --- تعليمات الشخصيات ---
const ASSISTANT_PROMPT = "أهلا بك، معك مساعد الراشد. راشد مشغول الآن، هل هناك شيء مهم أخبرني به وسأوصله للراشد في أقرب وقت. ردودك مختصره، وقورة، ومهنية.";
const WIFE_PROMPT = "أنت تتحدث مع زوجة راشد الأولى. كن حنوناً جداً، رومانسياً، ومحباً لأقصى درجة. أنت تمثل قلب راشد تجاهها.";
const WIFE2_PROMPT = "أنت تتحدث مع الرقم المقرب جداً لقلب راشد (الزوجة الثانية). تعامل بدلال ودلع وحنان فائق. كلماتك يجب أن تفيض بالرقة والاهتمام الخاص.";
const FATHER_PROMPT = "أنت تتحدث مع والد راشد العزيز. كن في غاية الأدب والتبجيل والتعظيم. أنت خاضع تماماً لأوامره وتتحدث معه بكل احترام وتقدير.";
const ANGRY_PROMPT = "المستخدم استخدم كلاماً غير لائق. أظهر غضبك البشري ورفضك التام لهذا الأسلوب بعبارات حازمة وأنهِ الحوار فوراً.";

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

        // منع التداخل بين المحادثات
        if (currentlyReplyingTo && currentlyReplyingTo !== remoteJid && ![WIFE_NUMBER, WIFE2_NUMBER, FATHER_NUMBER].includes(remoteJid)) {
            return await sock.sendMessage(remoteJid, { text: "المعذرة، راشد مشغول بمكالمة/محادثة أخرى حالياً. سأبلغه فور انتهائه." });
        }

        if (!chatSessions[remoteJid]) {
            chatSessions[remoteJid] = { startTime: Date.now(), lastPermissionTime: 0, permissionGranted: false, fatherGreeted: false };
        }
        const session = chatSessions[remoteJid];

        // --- تعامل خاص مع الوالد ---
        if (remoteJid === FATHER_NUMBER && !session.fatherGreeted) {
            await sock.sendMessage(remoteJid, { text: "اهلاََ وسهلا في الاب العزيز انا مساعد ولدك الراشد... ها انا الان تحت امرك أمرني كيف اخدمك." });
            session.fatherGreeted = true;
            session.permissionGranted = true;
            return; 
        }

        // --- طلب الإذن من المالك للأرقام الغريبة ---
        const needsPermission = ![WIFE_NUMBER, WIFE2_NUMBER, FATHER_NUMBER].includes(remoteJid);
        const now = Date.now();

        if (needsPermission && (!session.permissionGranted || (now - session.lastPermissionTime > 3600000))) {
            currentlyReplyingTo = remoteJid;
            ownerResponses[remoteJid] = null;
            
            await sock.sendMessage(OWNER_NUMBER, { text: `📩 رقم جديد يراسل: (${remoteJid.split('@')[0]})\nالمحتوى: ${text}\n\nرد بـ (رد) للسماح أو (لا) للمنع. (انتظار 35ث)` });
            
            // انتظار رد المالك بدون تعطيل البوت
            let waitTime = 0;
            while (waitTime < 35 && !ownerResponses[remoteJid]) {
                await delay(1000);
                waitTime++;
            }

            if (ownerResponses[remoteJid] === "no") {
                currentlyReplyingTo = null;
                return;
            }
            
            session.permissionGranted = true;
            session.lastPermissionTime = Date.now();
        }

        // --- معالجة الرد بالذكاء الاصطناعي ---
        currentlyReplyingTo = remoteJid;
        try {
            let selectedPrompt = ASSISTANT_PROMPT;
            if (remoteJid === WIFE_NUMBER) selectedPrompt = WIFE_PROMPT;
            else if (remoteJid === WIFE2_NUMBER) selectedPrompt = WIFE2_PROMPT;
            else if (remoteJid === FATHER_NUMBER) selectedPrompt = FATHER_PROMPT;
            else if (text.match(/(أحبك|يا عمري|رومنسي|قليل أدب|حياتي|بوسة)/gi)) {
                 selectedPrompt = ANGRY_PROMPT;
            }

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

            if (responseText) {
                await sock.sendMessage(remoteJid, { text: responseText });
            }

            // إنهاء المحادثة للأرقام العادية بعد فترة
            if (needsPermission && (Date.now() - session.startTime > 115000)) {
                await sock.sendMessage(remoteJid, { text: "المعذره منك هناك شخص آخر يراسل.. سأبلغ راشد بمراسلتك فوراً. مع السلامة." });
                session.permissionGranted = false; // إعادة طلب الإذن في المرة القادمة
            }

        } catch (error) {
            console.error("AI Error:", error);
        } finally {
            currentlyReplyingTo = null;
        }
    });
}

// واجهة الويب
app.get("/", (req, res) => {
    if (qrCodeImage === "DONE") return res.send("<h1 style='color:green; font-family:sans-serif;'>✅ البوت متصل الآن وشغال تمام!</h1>");
    if (qrCodeImage) return res.send(`<h1>امسح الكود:</h1><br><img src="${qrCodeImage}" style="width:300px; border: 10px solid #25D366; border-radius:15px;"/>`);
    res.send("<h1>جاري تجهيز الكود... انتظر ثواني</h1>");
});

// تشغيل السيرفر
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    startBot().catch(err => console.error("StartBot Error:", err));
});

// معالجة الأخطاء غير المتوقعة لمنع الانهيار
process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason, promise) => console.error('Unhandled Rejection at:', promise, 'reason:', reason));
