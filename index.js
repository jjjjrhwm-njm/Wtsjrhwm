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

// --- سحب الأرقام من البيئة لضمان السرية والدقة ---
const OWNER_NUMBER = (process.env.OWNER_NUMBER || "966554526287") + "@s.whatsapp.net";
const WIFE_NUMBER = (process.env.WIFE_NUMBER || "967782203551") + "@s.whatsapp.net";
const WIFE2_NUMBER = (process.env.WIFE2_NUMBER || "966599741982") + "@s.whatsapp.net";
const FATHER_NUMBER = (process.env.FATHER_NUMBER || "967783015253") + "@s.whatsapp.net";

let isBotActive = true; 
let currentlyReplyingTo = null; 
let ownerResponse = null; 
const chatSessions = {}; 

// --- تعليمات الشخصيات الصارمة والمحسنة لتكون بشرية أكثر (متنوعة، طبيعية، مختصرة) ---
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
    } catch (e) { console.log("❌ خطأ Firebase"); }
}

async function loadSessionFromFirebase() {
    if (db) {
        try {
            const doc = await db.collection('session').doc('whatsapp').get();
            if (doc.exists) {
                fs.writeFileSync('./auth_info/creds.json', JSON.stringify(doc.data()));
                console.log("📂 تم استعادة ملف الدخول من الخزنة");
            }
        } catch (e) { console.log("⚠️ لا توجد جلسة محفوظة"); }
    }
}

async function saveSessionToFirebase() {
    if (db && fs.existsSync('./auth_info/creds.json')) {
        try {
            const creds = JSON.parse(fs.readFileSync('./auth_info/creds.json'));
            await db.collection('session').doc('whatsapp').set(creds);
        } catch (e) { console.log("❌ فشل حفظ الجلسة"); }
    }
}

async function loadChatSessionFromFirebase(remoteJid) {
    if (db) {
        try {
            const doc = await db.collection('chats').doc(remoteJid).get();
            if (doc.exists) {
                chatSessions[remoteJid] = doc.data();
            }
        } catch (e) { console.log("⚠️ فشل تحميل الجلسة"); }
    }
}

async function saveChatSessionToFirebase(remoteJid) {
    if (db) {
        try {
            await db.collection('chats').doc(remoteJid).set(chatSessions[remoteJid]);
        } catch (e) { console.log("❌ فشل حفظ الجلسة"); }
    }
}

async function resetAllSessions() {
    try {
        // مسح كل الجلسات محليًا
        Object.keys(chatSessions).forEach(key => delete chatSessions[key]);
        
        // مسح كل الـ collections في Firebase
        if (db) {
            const chats = await db.collection('chats').get();
            const sessions = await db.collection('session').get();
            
            chats.forEach(doc => doc.ref.delete());
            sessions.forEach(doc => doc.ref.delete());
        }
        
        // مسح مجلد auth_info محليًا إذا وجد
        if (fs.existsSync('./auth_info')) {
            fs.rmSync('./auth_info', { recursive: true, force: true });
            console.log("تم مسح auth_info");
        }
        
        // إعادة تشغيل البوت
        process.exit(0); // يوقف العملية، Render يعيد التشغيل تلقائيًا
    } catch (e) {
        console.log("❌ فشل التصفير:", e);
    }
}

async function startBot() {
    if (!fs.existsSync('./auth_info')) fs.mkdirSync('./auth_info');
    await loadSessionFromFirebase();

    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({ version, auth: state, printQRInTerminal: false, browser: ["Mac OS", "Chrome", "114.0.5735.198"] });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        await saveSessionToFirebase();
    });

    sock.ev.on('connection.update', (update) => {
        if (update.qr) QRCode.toDataURL(update.qr, (err, url) => { qrCodeImage = url; });
        if (update.connection === 'open') qrCodeImage = "DONE";
        if (update.connection === 'close') startBot();
    });

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const remoteJid = jidNormalizedUser(msg.key.remoteJid);
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
        if (!text) return;

        await loadChatSessionFromFirebase(remoteJid); // تحميل الجلسة لكل محادثة

        // الأوامر تنفذ من أي رقم الآن (كما طلبت)، لكن الأساسية للمالك فقط للأمان
        if (text === "إيقاف" && remoteJid === OWNER_NUMBER) { isBotActive = false; return await sock.sendMessage(remoteJid, { text: "⚠️ تم إيقاف الردود." }); }
        if (text === "تفعيل" && remoteJid === OWNER_NUMBER) { isBotActive = true; return await sock.sendMessage(remoteJid, { text: "✅ تم تفعيل الردود." }); }
        if (text === "موافق") { ownerResponse = "yes"; return; }
        if (text === "رفض") { ownerResponse = "no"; return; }
        if (text.startsWith("مسح ")) {
            const targetJid = (text.split(" ")[1] + "@s.whatsapp.net");
            delete chatSessions[targetJid];
            if (db) await db.collection('chats').doc(targetJid).delete();
            return await sock.sendMessage(remoteJid, { text: `تم مسح جلسة ${targetJid}` });
        }
        if (text === "تصفير0") {
            await resetAllSessions();
            return await sock.sendMessage(remoteJid, { text: "تم التصفير، انتظر إعادة التشغيل." });
        }

        if (!isBotActive) return;

        // استثناء الأقارب من نظام التضارب
        const isSpecialNumber = (remoteJid === WIFE_NUMBER || remoteJid === WIFE2_NUMBER || remoteJid === FATHER_NUMBER);
        if (currentlyReplyingTo && currentlyReplyingTo !== remoteJid && !isSpecialNumber) {
            return await sock.sendMessage(remoteJid, { text: "المعذرة، مشغول مع شخص آخر، سأخبر راشد." });
        }

        if (!chatSessions[remoteJid]) {
            chatSessions[remoteJid] = { startTime: Date.now(), lastPermission: 0, permission: false, greeted: false, history: [], tasks: [], reminders: [] };
        }
        const session = chatSessions[remoteJid];

        // ترحيب الوالد الخاص (محسن ليكون أكثر بشرية)
        if (remoteJid === FATHER_NUMBER && !session.greeted) {
            await sock.sendMessage(remoteJid, { text: "أهلا يابوي، أنا سيليا مساعدة راشد، تحت أمرك تماماً، أمرني." });
            session.greeted = true; session.permission = true; 
            await saveChatSessionToFirebase(remoteJid);
            return;
        }

        // نظام الدقيقتين و 15 دقيقة راحة (للغرباء فقط) - محسن للسلاسة
        if (!isSpecialNumber && remoteJid !== OWNER_NUMBER) {
            const now = Date.now();
            if (now - session.startTime > 120000) {
                if (now - session.startTime < 900000) return; 
                else session.startTime = now;
            }
        }

        // نظام الإذن (للمرة الأولى أو كل ساعة - للغرباء فقط) - محسن بوقت أقصر
        const needsPermission = (Date.now() - session.lastPermission > 3600000);
        if (!isSpecialNumber && remoteJid !== OWNER_NUMBER && (needsPermission || !session.permission)) {
            ownerResponse = null;
            await sock.sendMessage(OWNER_NUMBER, { text: `📩 (${remoteJid.split('@')[0]}) يراسل. رد 'موافق' أو 'رفض' (تلقائي بعد 20ث)` });
            const waitStart = Date.now();
            while (Date.now() - waitStart < 20000) { // اختصار الانتظار
                if (ownerResponse) break;
                await new Promise(r => setTimeout(r, 500)); // تحديث أسرع
            }
            if (ownerResponse === "no") { delete chatSessions[remoteJid]; return; }
            session.permission = true; session.lastPermission = Date.now();
            await saveChatSessionToFirebase(remoteJid);
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

        let handled = false;
        let responseText = "";

        // ميزات إضافية مرنة ومراوقة (بدون حزم جديدة، مختصرة)
        if (text.startsWith("مهمة اضف ")) {
            handled = true;
            const task = text.replace("مهمة اضف ", "").trim();
            session.tasks.push(task);
            responseText = `أضفت المهمة: ${task}. رسالتك مهمة، سأذكر راشد.`;
            await saveChatSessionToFirebase(remoteJid);
        } else if (text === "مهامي") {
            handled = true;
            responseText = session.tasks.length ? `مهامك المهمة:\n${session.tasks.map((t, i) => `${i+1}. ${t}`).join("\n")}` : "ما عندك مهام حاليًا، رسالتك مهمة.";
        } else if (text.startsWith("تذكير اضف ")) {
            handled = true;
            const reminder = text.replace("تذكير اضف ", "").trim();
            session.reminders.push(reminder);
            responseText = `أضفت تذكير: ${reminder}. مهم جدًا، سأوصل لراشد.`;
            await saveChatSessionToFirebase(remoteJid);
        } else if (text === "تذكيراتي") {
            handled = true;
            responseText = session.reminders.length ? `تذكيراتك المهمة:\n${session.reminders.join("\n")}` : "ما عندك تذكيرات، رسالتك مهمة.";
        } else if (text.startsWith("بحث عن ")) {
            handled = true;
            const query = text.replace("بحث عن ", "").trim();
            responseText = `رسالتك مهمة، بحثت عن ${query}: (ملخص مختصر من ذاكرتي، لو تحتاج تفاصيل أكثر قل).`; // استخدم AI لملخص
        }

        if (!handled) {
            // توليد الرد مع سياق بشري (آخر 3 رسائل لتجنب التكرار)
            const historyContext = session.history?.slice(-3).map(h => `${h.role}: ${h.content}`).join("\n") || "";
            const finalPrompt = `${selectedPrompt}\nسياق: ${historyContext}\nأجب بالعربية فقط، مختصر وطبيعي زي الإنسان، اجعل المرسل يحس بأهميته.`;

            try {
                const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
                const completion = await groq.chat.completions.create({
                    messages: [{ role: "system", content: finalPrompt }, { role: "user", content: text }],
                    model: "llama-3.3-70b-versatile",
                    temperature: 0.7, // لتنويع بشري خفيف
                    max_tokens: 80 // اختصار قوي لردود قصيرة
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

        // حفظ السياق البشري
        if (!session.history) session.history = [];
        session.history.push({ role: "user", content: text }, { role: "assistant", content: responseText });
        if (session.history.length > 6) session.history.shift(); // ذاكرة قصيرة لطبيعية
        await saveChatSessionToFirebase(remoteJid);

        // رسالة الوداع للغرباء (محسنة لتكون أقصر)
        if (!isSpecialNumber && remoteJid !== OWNER_NUMBER && (Date.now() - session.startTime > 110000)) {
            await sock.sendMessage(remoteJid, { text: "مشغول مع آخر، سأخبر راشد، مع السلامة." });
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
