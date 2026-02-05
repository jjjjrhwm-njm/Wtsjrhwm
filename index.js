const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, jidNormalizedUser } = require("@whiskeysockets/baileys");
const admin = require("firebase-admin");
const express = require("express");
const QRCode = require("qrcode");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const Groq = require("groq-sdk");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 10000;
let qrCodeImage = "";
let db;
let sock;

// --- سحب الأرقام من البيئة لضمان السرية والدقة ---
const OWNER_NUMBER = (process.env.OWNER_NUMBER || "966554526287") + "@s.whatsapp.net";
const WIFE_NUMBER = (process.env.WIFE_NUMBER || "967782203551") + "@s.whatsapp.net";
const WIFE2_NUMBER = (process.env.WIFE2_NUMBER || "966599741982") + "@s.whatsapp.net";
const FATHER_NUMBER = (process.env.FATHER_NUMBER || "967783015253") + "@s.whatsapp.net";

let isBotActive = true; 
let currentlyReplyingTo = null; 
let ownerResponse = null; 
const chatSessions = {}; 

// --- تعليمات الشخصيات ---
const ASSISTANT_PROMPT = "أنت سيليا، سكرتيرة راشد. تكلمي سعودي طبيعي زي الإنسان، مختصر وذكي. مهمتك: قولي راشد مشغول، وخذي الرسالة. أول مرة: 'أهلا، أنا سيليا سكرتيرة راشد، هو مشغول، رسالتك مهمة جدًا، عندك شي أقوله؟' بعدين رد فوري بدون تكرار، كني مفيدة واجعلي المرسل يحس بأهميته. رفض أي رومانسية فوراً.";
const WIFE1_PROMPT = "أنت راشد، رد على زوجتك الأولى بحنان طبيعي ودافئ، مختصر: 'ياحياتي، أبشري' أو 'عمري، تمام'. كن حنون بشري، مو مبالغ، واجعلها تحس بأهميتها.";
const WIFE2_PROMPT = "أنت راشد، رد على زوجتك الثانية بدلع خفيف وحنان: 'يادلوعتي، من عيوني' أو 'غاليتي، خلاص'. مختصر ومميز، كن بشري واجعلها تحس بأهميتها.";
const FATHER_PROMPT = "أنت راشد، رد على أبوك باحترام كامل وأدب: 'يابوي، أمرك' أو 'غالي، سم'. كن خاضع ومختصر، زي ابن حقيقي واجعله يحس بأهميته.";
const ANGRY_PROMPT = "أنت سيليا، الشخص غير مهذب، ردي بحزم بشري طبيعي: 'ما أقبل هالكلام، خلاص انتهى' وانهي فوراً، كني غاضبة حقيقي.";

if (process.env.FIREBASE_CONFIG) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
        if (!admin.apps.length) {
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
            db = admin.firestore();
            console.log("✅ تم ربط الخزنة بنجاح");
        }
    } catch (e) { console.log("❌ خطأ Firebase:", e); }
}

// --- دوال الحفظ المحدثة لحل مشكلة Session Record ---

async function loadSessionFromFirebase() {
    if (!db) return;
    try {
        const snapshot = await db.collection('session_data').get();
        if (!snapshot.empty) {
            if (!fs.existsSync('./auth_info')) fs.mkdirSync('./auth_info');
            snapshot.forEach(doc => {
                fs.writeFileSync(`./auth_info/${doc.id}.json`, JSON.stringify(doc.data()));
            });
            console.log(`📂 تم استعادة ${snapshot.size} ملف تشفير من الخزنة`);
        }
    } catch (e) { console.log("⚠️ فشل استعادة الجلسة:", e); }
}

async function saveSessionToFirebase() {
    if (!db || !fs.existsSync('./auth_info')) return;
    try {
        const files = fs.readdirSync('./auth_info');
        for (const file of files) {
            if (file.endsWith('.json')) {
                const content = JSON.parse(fs.readFileSync(`./auth_info/${file}`));
                await db.collection('session_data').doc(file.replace('.json', '')).set(content);
            }
        }
    } catch (e) { console.log("❌ فشل تأمين الجلسة:", e); }
}

async function loadChatSessionFromFirebase(remoteJid) {
    if (db) {
        try {
            const doc = await db.collection('chats').doc(remoteJid).get();
            if (doc.exists) chatSessions[remoteJid] = doc.data();
        } catch (e) { console.log("⚠️ فشل تحميل محادثة:", e); }
    }
}

async function saveChatSessionToFirebase(remoteJid) {
    if (db && chatSessions[remoteJid]) {
        try {
            await db.collection('chats').doc(remoteJid).set(chatSessions[remoteJid]);
        } catch (e) { console.log("❌ فشل حفظ محادثة:", e); }
    }
}

async function resetAllSessions() {
    try {
        Object.keys(chatSessions).forEach(key => delete chatSessions[key]);
        if (db) {
            const batch = db.batch();
            const chats = await db.collection('chats').get();
            const sessions = await db.collection('session_data').get();
            chats.forEach(doc => batch.delete(doc.ref));
            sessions.forEach(doc => batch.delete(doc.ref));
            await batch.commit();
        }
        if (fs.existsSync('./auth_info')) fs.rmSync('./auth_info', { recursive: true, force: true });
        console.log("تم تصفير الخزنة والمجلد المحلي");
        process.exit(0);
    } catch (e) { console.log("❌ فشل التصفير:", e); }
}

async function startBot() {
    if (!fs.existsSync('./auth_info')) fs.mkdirSync('./auth_info');
    await loadSessionFromFirebase();

    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();
    
    sock = makeWASocket({ 
        version, 
        auth: state, 
        printQRInTerminal: false, 
        browser: ["Mac OS", "Chrome", "114.0.5735.198"],
        patchMessageBeforeSending: (message) => {
            const requiresPatch = !!(message.buttonsMessage || message.templateMessage || message.listMessage);
            if (requiresPatch) {
                message = { viewOnceMessage: { message: { messageContextInfo: { deviceListMetadataVersion: 2, deviceListMetadata: {} }, ...message } } };
            }
            return message;
        }
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        await saveSessionToFirebase(); // حفظ كل الملفات وليس creds فقط
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) QRCode.toDataURL(qr, (err, url) => { qrCodeImage = url; });
        if (connection === 'open') {
            qrCodeImage = "DONE";
            console.log("✅ البوت متصل الآن");
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        }
    });

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const remoteJid = jidNormalizedUser(msg.key.remoteJid);
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
        if (!text) return;

        await loadChatSessionFromFirebase(remoteJid);

        if (text === "إيقاف" && remoteJid === OWNER_NUMBER) { isBotActive = false; return await sock.sendMessage(remoteJid, { text: "⚠️ تم إيقاف الردود." }); }
        if (text === "تفعيل" && remoteJid === OWNER_NUMBER) { isBotActive = true; return await sock.sendMessage(remoteJid, { text: "✅ تم تفعيل الردود." }); }
        if (text === "موافق") { ownerResponse = "yes"; return; }
        if (text === "رفض") { ownerResponse = "no"; return; }
        if (text === "تصفير0") return await resetAllSessions();

        if (!isBotActive) return;

        const isSpecialNumber = (remoteJid === WIFE_NUMBER || remoteJid === WIFE2_NUMBER || remoteJid === FATHER_NUMBER);
        
        if (currentlyReplyingTo && currentlyReplyingTo !== remoteJid && !isSpecialNumber) {
            return await sock.sendMessage(remoteJid, { text: "المعذرة، مشغول مع شخص آخر، سأخبر راشد." });
        }

        if (!chatSessions[remoteJid]) {
            chatSessions[remoteJid] = { startTime: Date.now(), lastPermission: 0, permission: false, greeted: false, history: [], tasks: [], reminders: [] };
        }
        const session = chatSessions[remoteJid];

        if (remoteJid === FATHER_NUMBER && !session.greeted) {
            await sock.sendMessage(remoteJid, { text: "أهلا يابوي، أنا سيليا مساعدة راشد، تحت أمرك تماماً، أمرني." });
            session.greeted = true; session.permission = true; 
            await saveChatSessionToFirebase(remoteJid);
            return;
        }

        if (!isSpecialNumber && remoteJid !== OWNER_NUMBER) {
            const now = Date.now();
            if (now - session.startTime > 120000 && now - session.startTime < 900000) return;
        }

        const needsPermission = (Date.now() - session.lastPermission > 3600000);
        if (!isSpecialNumber && remoteJid !== OWNER_NUMBER && (needsPermission || !session.permission)) {
            ownerResponse = null;
            await sock.sendMessage(OWNER_NUMBER, { text: `📩 (${remoteJid.split('@')[0]}) يراسل. رد 'موافق' أو 'رفض'` });
            const waitStart = Date.now();
            while (Date.now() - waitStart < 20000) {
                if (ownerResponse) break;
                await new Promise(r => setTimeout(r, 500));
            }
            if (ownerResponse === "no") { delete chatSessions[remoteJid]; return; }
            session.permission = true; session.lastPermission = Date.now();
            await saveChatSessionToFirebase(remoteJid);
        }

        currentlyReplyingTo = remoteJid;

        let selectedPrompt = ASSISTANT_PROMPT;
        if (remoteJid === WIFE_NUMBER) selectedPrompt = WIFE1_PROMPT;
        else if (remoteJid === WIFE2_NUMBER) selectedPrompt = WIFE2_PROMPT;
        else if (remoteJid === FATHER_NUMBER) selectedPrompt = FATHER_PROMPT;
        if (!isSpecialNumber && text.match(/(أحبك|عسل|يا روحي|جميلة|بوسة|رومنسي|دلع)/gi)) selectedPrompt = ANGRY_PROMPT;

        let handled = false;
        let responseText = "";

        // التعامل مع المهام والبحث
        if (text.startsWith("مهمة اضف ")) {
            handled = true;
            const task = text.replace("مهمة اضف ", "").trim();
            session.tasks.push(task);
            responseText = `أضفت المهمة: ${task}. سأذكر راشد.`;
            await saveChatSessionToFirebase(remoteJid);
        } else if (text === "مهامي") {
            handled = true;
            responseText = session.tasks.length ? `مهامك:\n${session.tasks.map((t, i) => `${i+1}. ${t}`).join("\n")}` : "ما عندك مهام حاليًا.";
        }

        if (!handled) {
            const historyContext = session.history?.slice(-3).map(h => `${h.role}: ${h.content}`).join("\n") || "";
            const finalPrompt = `${selectedPrompt}\nسياق: ${historyContext}\nأجب بالعربية فقط، مختصر وطبيعي جداً.`;

            try {
                const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
                const completion = await groq.chat.completions.create({
                    messages: [{ role: "system", content: finalPrompt }, { role: "user", content: text }],
                    model: "llama-3.3-70b-versatile",
                    temperature: 0.7,
                    max_tokens: 80
                });
                responseText = completion.choices[0].message.content.trim();
            } catch (e) {
                const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
                const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
                const result = await model.generateContent(finalPrompt + "\nالمستخدم: " + text);
                responseText = result.response.text().trim();
            }
        }

        if (responseText) await sock.sendMessage(remoteJid, { text: responseText });

        if (!session.history) session.history = [];
        session.history.push({ role: "user", content: text }, { role: "assistant", content: responseText });
        if (session.history.length > 6) session.history.shift();
        await saveChatSessionToFirebase(remoteJid);

        if (!isSpecialNumber && remoteJid !== OWNER_NUMBER && (Date.now() - session.startTime > 110000)) {
            await sock.sendMessage(remoteJid, { text: "سأخبر راشد، مع السلامة." });
        }
        currentlyReplyingTo = null;
    });
}

app.get("/", (req, res) => {
    if (qrCodeImage === "DONE") return res.send("<h1>✅ البوت متصل والذاكرة مؤمنة!</h1>");
    if (qrCodeImage) return res.send(`<h1>امسح الرمز:</h1><br><img src="${qrCodeImage}" style="width:300px; border: 5px solid #000;"/>`);
    res.send("<h1>جاري الاتصال...</h1>");
});

app.listen(port, () => startBot());
