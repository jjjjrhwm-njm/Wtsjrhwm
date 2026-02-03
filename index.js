const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const admin = require("firebase-admin");
const express = require("express");
const QRCode = require("qrcode");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require("fs");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 10000;
let qrCodeImage = "";
let db;

// ١. إعداد الخزنة (Firebase) بطريقة آمنة
if (process.env.FIREBASE_CONFIG) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            db = admin.firestore(); // تعريف قاعدة البيانات هنا بعد التأكد من التشغيل
            console.log("✅ تم ربط الخزنة بنجاح");
        }
    } catch (e) { 
        console.log("❌ خطأ في إعدادات الخزنة:", e.message); 
    }
}

async function startBot() {
    if (!fs.existsSync('./auth_info')) fs.mkdirSync('./auth_info');
    
    // ٢. محاولة سحب الجلسة من الخزنة لكي لا يطلب الرمز مجدداً
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
    
    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        browser: ["Mac OS", "Chrome", "114.0.5735.198"] // الهوية التي تمنع الحظر
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        // ٣. حفظ الجلسة في الخزنة تلقائياً
        if (db) {
            try {
                const creds = JSON.parse(fs.readFileSync('./auth_info/creds.json'));
                await db.collection('session').doc('whatsapp').set(creds);
            } catch (e) { console.log("خطأ في حفظ البيانات:", e.message); }
        }
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            QRCode.toDataURL(qr, (err, url) => { qrCodeImage = url; });
        }
        if (connection === 'open') {
            console.log("✅ متصل الآن وشغال!");
            qrCodeImage = "DONE";
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        }
    });

    // ٤. رد جيمني الذكي (تم تحديث الموديل هنا)
    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.key.fromMe && msg.message && process.env.GEMINI_API_KEY) {
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
            if (text) {
                try {
                    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
                    // التعديل: استخدام gemini-1.5-flash بدلاً من gemini-pro المتعطل
                    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
                    const result = await model.generateContent(text);
                    await sock.sendMessage(msg.key.remoteJid, { text: result.response.text() });
                } catch (e) { console.log("Gemini Error:", e.message); }
            }
        }
    });
}

// واجهة المتصفح لعرض الرمز
app.get("/", (req, res) => {
    res.setHeader('Refresh', '8');
    if (qrCodeImage === "DONE") return res.send("<h1>✅ متصل والذاكرة مفعّلة! جرب إرسال رسالة الآن.</h1>");
    if (qrCodeImage) return res.send(`<h1>امسح الرمز لمرة واحدة فقط:</h1><br><img src="${qrCodeImage}" style="width:300px; border: 5px solid #000;"/>`);
    res.send("<h1>جاري الاتصال... انتظر ظهور الرمز خلال ثواني</h1>");
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
    startBot();
});
