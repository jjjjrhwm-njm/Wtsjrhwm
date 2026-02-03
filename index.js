const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const admin = require("firebase-admin");
const express = require("express");
const QRCode = require("qrcode");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require("fs");
require("dotenv").config();

// ١. إعداد الخزنة (Firebase)
if (process.env.FIREBASE_CONFIG) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("✅ تم ربط الخزنة بنجاح");
    } catch (e) { console.log("❌ خطأ في إعدادات الخزنة:", e.message); }
}

const db = admin.firestore();
const app = express();
const port = process.env.PORT || 10000;
let qrCodeImage = "";

async function startBot() {
    if (!fs.existsSync('./auth_info')) fs.mkdirSync('./auth_info');
    
    // ٢. محاولة استعادة الجلسة
    try {
        const doc = await db.collection('session').doc('whatsapp').get();
        if (doc.exists) {
            fs.writeFileSync('./auth_info/creds.json', JSON.stringify(doc.data()));
            console.log("📂 تم سحب ملف الدخول من الخزنة");
        }
    } catch (e) { console.log("⚠️ لا توجد جلسة محفوظة حالياً"); }

    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();
    
    // ٣. الاتصال بالهوية القوية (تجنب الحظر)
    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        browser: ["Mac OS", "Chrome", "114.0.5735.198"] // الهوية التي نجحت معك
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        // حفظ الجلسة في الخزنة فوراً
        const creds = JSON.parse(fs.readFileSync('./auth_info/creds.json'));
        await db.collection('session').doc('whatsapp').set(creds);
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            QRCode.toDataURL(qr, (err, url) => { qrCodeImage = url; });
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log("🔄 إعادة اتصال...");
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log("✅ متصل الآن!");
            qrCodeImage = "DONE";
        }
    });

    // ٤. رد جيمني
    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.key.fromMe && msg.message && process.env.GEMINI_API_KEY) {
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
            if (text) {
                try {
                    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
                    const model = genAI.getGenerativeModel({ model: "gemini-pro" });
                    const result = await model.generateContent(text);
                    await sock.sendMessage(msg.key.remoteJid, { text: result.response.text() });
                } catch (e) { console.log("Gemini Error:", e.message); }
            }
        }
    });
}

app.get("/", (req, res) => {
    res.setHeader('Refresh', '8');
    if (qrCodeImage === "DONE") return res.send("<h1>✅ متصل والذاكرة مفعّلة!</h1>");
    if (qrCodeImage) return res.send(`<h1>امسح الرمز للمرة الأخيرة:</h1><br><img src="${qrCodeImage}" style="width:300px; border: 5px solid #000;"/>`);
    res.send("<h1>جاري الاتصال... انتظر ظهور الرمز</h1>");
});

app.listen(port, () => { startBot(); });
