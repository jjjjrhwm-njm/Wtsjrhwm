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

// --- أرقام الاتصال الرئيسية من البيئة ---
const formatNumber = (num) => num.replace(/\D/g, '') + "@s.whatsapp.net";
const OWNER_NUMBER = formatNumber(process.env.OWNER_NUMBER || "966554526287");
const WIFE_NUMBER = formatNumber(process.env.WIFE_NUMBER || "967782203551");
const WIFE2_NUMBER = formatNumber(process.env.WIFE2_NUMBER || "966599741982");
const FATHER_NUMBER = formatNumber(process.env.FATHER_NUMBER || "967783015253");

let isBotActive = true;
let currentlyReplyingTo = null;
const chatSessions = {}; // جلسات محادثات مع تاريخ وسياق بشري

// --- تعليمات شخصيات بشرية ومتنوعة، مع التركيز على الاختصار والطبيعية ---
const SYSTEM_PROMPTS = {
    assistant: "أنت أحمد، سكرتير راشد الشخصي. تكلم سعودي طبيعي، مختصر زي الإنسان اللي مشغول. إذا أول مرة: 'أهلا، أنا أحمد سكرتير راشد، راشد مشغول، شو عندك؟' بعد كده رد مباشر، ذكي، مفيد، بدون تكرار. لو سأل عن راشد: 'مشغول، أقدر أساعد؟' كن حذر، رفض أي رومانسية فوراً.",
    wife: "أنت راشد، رد على زوجتك الأولى بحب طبيعي ودافئ، مختصر: 'ياعمري، أبشري' أو 'حياتي، تمام'. كن حنون لكن مو مبالغ.",
    wife2: "أنت راشد، رد على زوجتك الثانية بدلع خفيف وحنان: 'يادلوعتي، من عيوني' أو 'غاليتي، خلاص'. مختصر ومميز.",
    father: "أنت راشد، رد على أبوك باحترام كامل وأدب: 'يابوي، أمرك' أو 'غالي، سم'. كن خاضع ومختصر.",
    angry: "أنت أحمد، الشخص غير مهذب، رد بحزم بشري: 'ما أقبل هالكلام، خلاص انتهى' وانهي."
};

// إعداد Firebase للجلسات والسياق
if (process.env.FIREBASE_CONFIG) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
        if (!admin.apps.length) {
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
            db = admin.firestore();
        }
    } catch (e) { console.error("Firebase error:", e); }
}

async function loadSessionFromFirebase() {
    if (db) {
        try {
            const doc = await db.collection('session').doc('whatsapp').get();
            if (doc.exists) {
                fs.writeFileSync('./auth_info/creds.json', JSON.stringify(doc.data()));
                console.log("Loaded auth from Firebase");
            }
        } catch (e) { console.error("Load session failed:", e); }
    }
}

async function saveSessionToFirebase() {
    if (db && fs.existsSync('./auth_info/creds.json')) {
        try {
            const creds = JSON.parse(fs.readFileSync('./auth_info/creds.json'));
            await db.collection('session').doc('whatsapp').set(creds);
            console.log("Saved auth to Firebase");
        } catch (e) { console.error("Save session failed:", e); }
    }
}

async function loadChatSessionsFromFirebase() {
    if (db) {
        try {
            const snapshot = await db.collection('chats').get();
            snapshot.forEach(doc => {
                chatSessions[doc.id] = doc.data();
            });
            console.log("Loaded chat sessions");
        } catch (e) { console.error("Load chats failed:", e); }
    }
}

async function saveChatSessionToFirebase(jid) {
    if (db) {
        try {
            await db.collection('chats').doc(jid).set(chatSessions[jid]);
        } catch (e) { console.error("Save chat failed:", e); }
    }
}

async function startBot() {
    if (!fs.existsSync('./auth_info')) fs.mkdirSync('./auth_info');

    await loadSessionFromFirebase();
    await loadChatSessionsFromFirebase();

    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();
    
    sock = makeWASocket({ 
        version, 
        auth: state, 
        printQRInTerminal: false, 
        browser: ["Rashed_Secretary", "Safari", "1.0"]
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        await saveSessionToFirebase();
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) QRCode.toDataURL(qr, (err, url) => { qrCodeImage = url; });
        if (connection === 'open') { qrCodeImage = "DONE"; console.log("Connected"); }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        }
    });

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const jid = jidNormalizedUser(msg.key.remoteJid);
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
        if (!text.trim()) return;

        if (jid === OWNER_NUMBER) {
            if (text === "123123") { isBotActive = false; return sock.sendMessage(jid, { text: "Bot paused." }); }
            if (text === "321321") { isBotActive = true; return sock.sendMessage(jid, { text: "Bot active." }); }
            if (text.startsWith("!clear ")) {
                const targetJid = formatNumber(text.split(" ")[1]);
                delete chatSessions[targetJid];
                await saveChatSessionToFirebase(targetJid);
                return sock.sendMessage(jid, { text: `Cleared ${targetJid}` });
            }
            return;
        }

        if (!isBotActive) return;

        if (!chatSessions[jid]) {
            chatSessions[jid] = { history: [], greeted: false, tasks: [], reminders: [] };
        }
        const session = chatSessions[jid];

        let role = "assistant";
        if (jid === WIFE_NUMBER) role = "wife";
        else if (jid === WIFE2_NUMBER) role = "wife2";
        else if (jid === FATHER_NUMBER) role = "father";
        
        if (role === "assistant" && text.match(/(أحبك|عسل|روحي|بوسة|حبيبي)/gi)) role = "angry";

        if (currentlyReplyingTo && currentlyReplyingTo !== jid && role === "assistant") {
            return sock.sendMessage(jid, { text: "أعتذر، مشغول مع آخر، سأخبر راشد." });
        }

        currentlyReplyingTo = jid;
        await sock.sendPresenceUpdate('composing', jid);

        let handled = false;
        let responseText = "";

        // ميزات سكرتير بسيطة (بدون حزم إضافية)
        if (text.startsWith("!مهمة ")) {
            handled = true;
            const task = text.replace("!مهمة ", "");
            session.tasks.push(task);
            responseText = `أضفت: ${task}`;
            await saveChatSessionToFirebase(jid);
        } else if (text === "!مهام") {
            handled = true;
            responseText = session.tasks.length ? session.tasks.map((t, i) => `${i+1}. ${t}`).join("\n") : "ما عندك مهام.";
        } else if (text.startsWith("!تذكير ")) {
            handled = true;
            const reminder = text.replace("!تذكير ", "");
            session.reminders.push(reminder);
            responseText = `سأذكرك بـ: ${reminder} (ملاحظة: تذكير يدوي، قل !تذكيرات لرؤيتها)";
            await saveChatSessionToFirebase(jid);
        } else if (text === "!تذكيرات") {
            handled = true;
            responseText = session.reminders.length ? session.reminders.join("\n") : "ما عندك تذكيرات.";
        }

        if (!handled) {
            const historyContext = session.history.slice(-3).map(h => `${h.role}: ${h.content}`).join("\n");
            const instruction = session.greeted ? "رد طبيعي، مختصر، ذكي بدون مقدمات." : "عرف نفسك باختصار.";
            const finalPrompt = `${SYSTEM_PROMPTS[role]}\n${instruction}\nسياق: ${historyContext}\nالمستخدم: ${text}\nأجب بالعربية فقط.`;

            try {
                const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
                const completion = await groq.chat.completions.create({
                    messages: [{ role: "system", content: finalPrompt }],
                    model: "llama-3.1-70b-versatile",
                    temperature: 0.8, // تنويع بشري
                    max_tokens: 100 // اختصار قوي
                });
                responseText = completion.choices[0].message.content.trim();
            } catch (e) {
                console.error("AI error:", e);
                responseText = "مشكلة فنية، جرب بعد شوي.";
            }
        }

        await sock.sendMessage(jid, { text: responseText });
        session.greeted = true;
        session.history.push({ role: "user", content: text }, { role: "assistant", content: responseText });
        if (session.history.length > 6) session.history.shift(); // ذاكرة قصيرة بشرية
        await saveChatSessionToFirebase(jid);

        currentlyReplyingTo = null;
    });
}

app.get("/", (req, res) => {
    if (qrCodeImage === "DONE") return res.send("<h1>✅ متصل</h1>");
    if (qrCodeImage) return res.send(`<img src="${qrCodeImage}"/>`);
    res.send("<h1>جاري...</h1>");
});

app.listen(port, () => {
    console.log(`Server on ${port}`);
    startBot();
});

process.on('unhandledRejection', (reason) => console.error('Error:', reason));
