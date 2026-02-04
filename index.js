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
const WIFE2_NUMBER = "966599741982@s.whatsapp.net"; // الرقم الجديد (الزوجة الثانية)
const FATHER_NUMBER = "967783015253@s.whatsapp.net";
const EXEMPT_NUMBER = "966554526287@s.whatsapp.net"; 

let isBotActive = true; 
let currentlyReplyingTo = null; 
let ownerResponse = null; 
const chatSessions = {}; 

// --- تعليمات الشخصيات (Prompts) ---
const ASSISTANT_PROMPT = "أهلا بك، معك مساعد الراشد. راشد مشغول الآن، هل هناك شيء مهم أخبرني به وسأوصله للراشد في أقرب وقت. ردودك مختصره، وقورة، ومهنية.";
const WIFE_PROMPT = "أنت تتحدث مع زوجة راشد الأولى. كن حنوناً جداً، رومانسياً، ومحباً لأقصى درجة. أنت تمثل قلب راشد تجاهها.";
const WIFE2_PROMPT = "أنت تتحدث مع الرقم المقرب جداً لقلب راشد (الزوجة الثانية). تعامل بدلال ودلع وحنان فائق. كلماتك يجب أن تفيض بالرقة والاهتمام الخاص، كن حنوناً جداً وتصرف كأنك تعبر عن دلال راشد لها.";
const FATHER_PROMPT = "أنت تتحدث مع والد راشد العزيز. كن في غاية الأدب والتبجيل والتعظيم. أنت خاضع تماماً لأوامره وتتحدث معه بكل احترام وتقدير.";
const ANGRY_PROMPT = "المستخدم استخدم كلاماً غير لائق. أظهر غضبك البشري ورفضك التام لهذا الأسلوب بعبارات حازمة وأنهِ الحوار فوراً.";

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
    const sock = makeWASocket({ version, auth: state, printQRInTerminal: false, browser: ["Mac OS", "Chrome", "114.0.5735.198"] });

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

        // أوامر المالك
        if (remoteJid === OWNER_NUMBER) {
            if (text === "123123") { isBotActive = false; return await sock.sendMessage(remoteJid, { text: "⚠️ تم إيقاف الردود." }); }
            if (text === "321321") { isBotActive = true; return await sock.sendMessage(remoteJid, { text: "✅ تم تفعيل الردود." }); }
            if (text === "رد") { ownerResponse = "yes"; return; }
            if (text === "لا") { ownerResponse = "no"; return; }
        }

        if (!isBotActive) return;

        // منطق التضارب (مستثنى منه الزوجات والوالد)
        if (currentlyReplyingTo && currentlyReplyingTo !== remoteJid && remoteJid !== WIFE_NUMBER && remoteJid !== WIFE2_NUMBER && remoteJid !== FATHER_NUMBER) {
            return await sock.sendMessage(remoteJid, { text: "سأبلغ راشد بشأنك في أقرب وقت مع السلامه هناك شخص آخر يراسل." });
        }

        if (!chatSessions[remoteJid]) {
            chatSessions[remoteJid] = { startTime: Date.now(), lastPermissionTime: 0, permissionGranted: false, fatherGreeted: false };
        }
        const session = chatSessions[remoteJid];

        // التعامل مع الوالد
        if (remoteJid === FATHER_NUMBER && !session.fatherGreeted) {
            await sock.sendMessage(remoteJid, { text: "اهلاََ وسهلا في الاب العزيز انا مساعد ولدك الراشد وقد أعطاني تعليمات علا رقمك في حال قمت بالمراسله ان ارد عليك بكل ادب واحترام وان اكون لاوامرك خاضع ذليل وها انا الان تحت امرك أمرني كيف اخدمك." });
            session.fatherGreeted = true;
            session.permissionGranted = true;
            return; 
        }

        // نظام الدقيقتين (مستثنى منه الزوجات والوالد والمالك)
        if (remoteJid !== WIFE_NUMBER && remoteJid !== WIFE2_NUMBER && remoteJid !== FATHER_NUMBER && remoteJid !== EXEMPT_NUMBER) {
            const now = Date.now();
            if (now - session.startTime > 120000) {
                if (now - session.startTime < 900000) return;
                else session.startTime = now;
            }
        }

        // نظام الإذن (مستثنى منه الزوجات والوالد)
        const now = Date.now();
        if (remoteJid !== WIFE_NUMBER && remoteJid !== WIFE2_NUMBER && remoteJid !== FATHER_NUMBER && (!session.permissionGranted || (now - session.lastPermissionTime > 3600000))) {
            ownerResponse = null;
            await sock.sendMessage(OWNER_NUMBER, { text: `📩 (${remoteJid.split('@')[0]}) يراسل الآن.\nهل أرد؟ (رد/لا) أو انتظر 35ث.` });
            const waitStart = Date.now();
            while (Date.now() - waitStart < 35000) {
                if (ownerResponse) break;
                await new Promise(r => setTimeout(r, 1000));
            }
            if (ownerResponse === "no") return;
            session.permissionGranted = true;
            session.lastPermissionTime = Date.now();
        }

        currentlyReplyingTo = remoteJid;

        // اختيار الشخصية
        let selectedPrompt = ASSISTANT_PROMPT;
        if (remoteJid === WIFE_NUMBER) selectedPrompt = WIFE_PROMPT;
        else if (remoteJid === WIFE2_NUMBER) selectedPrompt = WIFE2_PROMPT;
        else if (remoteJid === FATHER_NUMBER) selectedPrompt = FATHER_PROMPT;
        else if (text.match(/(أحبك|يا عمري|رومنسي|قليل أدب|حياتي|بوسة)/gi)) {
             if (remoteJid !== WIFE_NUMBER && remoteJid !== WIFE2_NUMBER) selectedPrompt = ANGRY_PROMPT;
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

        if (responseText) await sock.sendMessage(remoteJid, { text: responseText });

        if (remoteJid !== WIFE_NUMBER && remoteJid !== WIFE2_NUMBER && remoteJid !== FATHER_NUMBER && remoteJid !== EXEMPT_NUMBER && (Date.now() - session.startTime > 115000)) {
            await sock.sendMessage(remoteJid, { text: "المعذره منك هناك شخص آخر يراسل ولازم ارد عليه مع السلامه وسابلغ راشد انك قمت بمراسلته في أقرب وقت." });
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
