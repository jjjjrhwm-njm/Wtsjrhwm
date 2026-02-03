const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const admin = require("firebase-admin");
const express = require("express");
const QRCode = require("qrcode");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require("fs");
require("dotenv").config();

// إعداد Firebase من متغيرات البيئة
if (process.env.FIREBASE_CONFIG) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
    });
}

const db = admin.firestore();
const app = express();
const port = process.env.PORT || 10000;
let qrCodeImage = "";

async function startBot() {
    // محاولة استعادة الجلسة من Firebase قبل البدء
    if (!fs.existsSync('./auth_info')) fs.mkdirSync('./auth_info');
    
    try {
        const doc = await db.collection('session').doc('whatsapp').get();
        if (doc.exists) {
            fs.writeFileSync('./auth_info/creds.json', JSON.stringify(doc.data()));
            console.log("✅ تم استعادة الجلسة من Firebase");
        }
    } catch (e) { console.log("لا توجد جلسة محفوظة"); }

    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const sock = makeWASocket({ auth: state, printQRInTerminal: false });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        // حفظ الجلسة في Firebase فور تحديثها
        const creds = JSON.parse(fs.readFileSync('./auth_info/creds.json'));
        await db.collection('session').doc('whatsapp').set(creds);
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, qr } = update;
        if (qr) QRCode.toDataURL(qr, (err, url) => { qrCodeImage = url; });
        if (connection === 'open') { qrCodeImage = "DONE"; console.log("متصل!"); }
        if (connection === 'close') startBot();
    });

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.key.fromMe && msg.message) {
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
            if (text && process.env.GEMINI_API_KEY) {
                const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
                const model = genAI.getGenerativeModel({ model: "gemini-pro" });
                const result = await model.generateContent(text);
                await sock.sendMessage(msg.key.remoteJid, { text: result.response.text() });
            }
        }
    });
}

app.get("/", (req, res) => {
    if (qrCodeImage === "DONE") return res.send("<h1>✅ متصل والذاكرة مفعّلة!</h1>");
    if (qrCodeImage) return res.send(`<h1>امسح للمرة الأخيرة:</h1><img src="${qrCodeImage}"/>`);
    res.send("<h1>جاري الاتصال...</h1>");
});

app.listen(port, () => { startBot(); });
