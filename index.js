const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const express = require("express");
const QRCode = require("qrcode");
const { GoogleGenerativeAI } = require("@google/generative-ai");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 10000;
let qrCodeImage = "";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const sock = makeWASocket({ 
        auth: state, 
        printQRInTerminal: false,
        browser: ["Ubuntu", "Chrome", "20.0.04"]
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            QRCode.toDataURL(qr, (err, url) => {
                qrCodeImage = url;
            });
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log("تم الاتصال!");
            qrCodeImage = "DONE";
        }
    });

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.key.fromMe && msg.message) {
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
            if (text && process.env.GEMINI_API_KEY) {
                try {
                    const model = genAI.getGenerativeModel({ model: "gemini-pro" });
                    const result = await model.generateContent(text);
                    await sock.sendMessage(msg.key.remoteJid, { text: result.response.text() });
                } catch (e) { console.log("خطأ جيمني:", e); }
            }
        }
    });
}

app.get("/", (req, res) => {
    res.setHeader('Refresh', '7'); // تحديث تلقائي كل 7 ثواني
    if (qrCodeImage === "DONE") return res.send("<h1>مبروك! تم الربط بنجاح. البوت يعمل الآن.</h1>");
    if (qrCodeImage) return res.send(`<h1>امسح الرمز الآن:</h1><br><img src="${qrCodeImage}" style="width:300px;"/><p>سيختفي هذا الرمز بمجرد المسح.</p>`);
    res.send("<h1>جاري إنشاء الرمز... الصفحة ستحدث نفسها تلقائياً، انتظر قليلاً.</h1>");
});

app.listen(port, () => {
    startBot();
});
