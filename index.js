const { default: makeWASocket, useMultiFileAuthState, delay } = require("@whiskeysockets/baileys");
const express = require("express");
const QRCode = require("qrcode");
const { GoogleGenerativeAI } = require("@google/generative-ai");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 3000;
let qrCodeImage = "";

// إعداد جيمني
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const sock = makeWASocket({ auth: state, printQRInTerminal: true });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, qr } = update;
        if (qr) {
            // تحويل الـ QR لصورة لعرضها في المتصفح
            QRCode.toDataURL(qr, (err, url) => {
                qrCodeImage = url;
            });
        }
        if (connection === 'open') {
            console.log("تم اتصال الواتساب بنجاح!");
            qrCodeImage = "DONE"; // تم المسح بنجاح
        }
    });

    // الرد على الرسائل باستخدام جيمني
    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.key.fromMe && msg.message) {
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
            if (text) {
                const model = genAI.getGenerativeModel({ model: "gemini-pro" });
                const result = await model.generateContent(text);
                const response = await result.response;
                await sock.sendMessage(msg.key.remoteJid, { text: response.text() });
            }
        }
    });
}

// عرض الـ QR في المتصفح
app.get("/", (req, res) => {
    if (qrCodeImage === "DONE") return res.send("<h1>تم ربط الواتساب بنجاح! البوت يعمل الآن.</h1>");
    if (qrCodeImage) return res.send(`<h1>امسح الرمز لتشغيل البوت:</h1><img src="${qrCodeImage}" />`);
    res.send("<h1>جاري إنشاء الرمز... انتظر ثواني</h1>");
});

app.listen(port, () => {
    console.log(`الموقع يعمل على الرابط: http://localhost:${port}`);
    startBot();
});
