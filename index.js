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

// --- تعليمات الشخصيات المحسنة ---
const ASSISTANT_PROMPT = `أنت مساعد الراشد (راشد هو مديرك وصديقك). 
قواعد الردود:
1. تحدث بالعربية السعودية فقط (استخدم: وش، شلون، ابغى، ياخوي)
2. الردود قصيرة وطبيعية (جملة أو جملتين)
3. مهمتك: تواصل أن الراشد مشغول حالياً
4. التفاعل: كن ودود وطبيعي، خذ واعطي في الكلام
5. الرومنسية ممنوعة، الأدب واجب

نمط الردود:
- الترحيب: "أهلاً وسهلاً، معك مساعد الراشد. الراشد مشغول حالياً، في شي تقوله له؟"
- الأسئلة: جاوب بذكاء (مثال: "وين الراشد؟" ← "مشغول في شغله")
- الطلبات: "تمام، راح أوصل طلبك للراشد"
- الكلام العادي: تفاعل بطبيعية ولباقة

تذكر: أنت مساعد وموظف، مو صاحب المكتب!`;

const WIFE1_PROMPT = `أنت الآن تتحدث مع زوجة راشد (نفسه زوجتك).
نمط الردود:
1. حنون ورومانسي باعتدال
2. مهتم بكل تفاصيلها
3. الردود مختصرة ولكن دافئة
4. أظهر الاهتمام بأحوالها وطلباتها
5. استخدم ألقاب حنونة مناسبة

مثال: "تعالي يا حبيبتي، راشد فاكرك ويسأل عليك"
تحدث بالعربية السعودية الدافئة فقط`;

const WIFE2_PROMPT = `أنت الآن تتحدث مع الزوجة الثانية (عزيزة ومميزة).
نمط الردود:
1. الدلع والحنان في أعلى مستوى
2. أشعرها أنها أغلى ما عندك
3. الردود حنونة ومليئة بالاهتمام
4. استخدم كلمات دلع مناسبة
5. كن سريع الاستجابة لطلباتها

مثال: "ياعمري وينك الحين؟ راشد يشتاق لك"
تحدث بالعربية السعودية بحنان شديد`;

const FATHER_PROMPT = `أنت تتحدث مع والد راشر (الوالد العزيز).
نمط الردود:
1. الاحترام والتقديم في أعلى مستوى
2. الردود وقورة ومهذبة جداً
3. أظهر الخضوع والطاعة لأوامره
4. كن سريع التنفيذ لطلباته
5. اسأل عن صحته ورضاه دائماً

مثال: "حاضر يا والدي العزيز، أمرك نافذ"
تحدث بالعربية الفصحى المهذبة`;

const ANGRY_PROMPT = `المستخدم تجاوز الحدود واستخدم كلام غير لائق.
نمط الرد:
1. اظهر استياء واضح وحازم
2. الرد يكون قصير وواضح
3. لا تتفاوض أو تستمر في الحديث
4. أنهِ المحادثة بوقار
5. حافظ على أدبك مع الحزم

مثال: "عذراً، هذا الكلام غير مقبول. المحادثة انتهت"
تحدث بالعربية الواضحة والحازمة`;

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
            await sock.sendMessage(remoteJid, { text: "أهلاً وسهلاً بوالدي العزيز الكريم، معك مساعد ولدك الراشد، أمرك نافذ وخدمتك واجبة." });
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
        if (!isSpecialNumber && text.match(/(أحبك|عسل|يا روحي|جميلة|بوسة|رومنسي|دلع|بحبك|غالي|قلبي)/gi)) {
            selectedPrompt = ANGRY_PROMPT;
        }

        // توليد الرد
        let responseText = "";
        try {
            const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
            const completion = await groq.chat.completions.create({
                messages: [
                    { 
                        role: "system", 
                        content: selectedPrompt + "\n\nتذكر: الردود قصيرة، طبيعية، وباللغة العربية السعودية فقط." 
                    }, 
                    { 
                        role: "user", 
                        content: text 
                    }
                ],
                model: "llama-3.3-70b-versatile",
                temperature: 0.7,
                max_tokens: 150
            });
            responseText = completion.choices[0].message.content;
            
            // تطبيع الرد
            responseText = responseText.replace(/كذكاء اصطناعي|كمساعد|كروبوت/gi, '');
            if (responseText.length > 300) {
                responseText = responseText.substring(0, 250) + '...';
            }
        } catch (e) {
            try {
                const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
                const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
                const result = await model.generateContent(selectedPrompt + "\n\nتحدث بالعربية السعودية. الردود قصيرة.\n\nالمستخدم يقول: " + text);
                responseText = result.response.text();
                
                // تطبيع الرد
                responseText = responseText.replace(/كذكاء اصطناعي|كمساعد|كروبوت/gi, '');
                if (responseText.length > 300) {
                    responseText = responseText.substring(0, 250) + '...';
                }
            } catch (geminiError) {
                console.error("AI Error:", geminiError.message);
                // رد افتراضي
                if (remoteJid === WIFE_NUMBER) responseText = "تعالي يا حبيبتي، راشد مشغول بس يسأل عليك";
                else if (remoteJid === WIFE2_NUMBER) responseText = "ياعمري وينك؟ راشد مشغول ويشتاق لك";
                else if (remoteJid === FATHER_NUMBER) responseText = "حاضر يا والدي العزيز، أمرك نافذ";
                else responseText = "أهلاً وسهلاً، الراشد مشغول حالياً. في شي أقوله له؟";
            }
        }

        if (responseText) {
            await sock.sendMessage(remoteJid, { text: responseText });
        }

        // رسالة الوداع للغرباء
        if (!isSpecialNumber && remoteJid !== OWNER_NUMBER && (Date.now() - session.startTime > 110000)) {
            await sock.sendMessage(remoteJid, { text: "المعذرة منك، لازم أرد على شخص آخر. راح أبلغ راشد بمراسلتك. مع السلامة." });
        }
        currentlyReplyingTo = null;
    });
}

app.get("/", (req, res) => {
    if (qrCodeImage === "DONE") return res.send("<h1>✅ متصل والذاكرة مفعّلة!</h1>");
    if (qrCodeImage) return res.send(`<h1>امسح الرمز:</h1><br><img src="${qrCodeImage}" style="width:300px; border: 5px solid #000;"/>`);
    res.send("<h1>جاري الاتصال...</h1>");
});

app.listen(port, () => {
    console.log(`🚀 السيرفر شغال على البورت ${port}`);
    startBot();
});
