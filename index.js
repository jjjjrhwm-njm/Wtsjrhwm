const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const express = require("express");
const QRCode = require("qrcode");
const { GoogleGenerativeAI } = require("@google/generative-ai");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 10000;
let qrCodeImage = "";

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        // تغيير هوية المتصفح لتجنب حظر Render
        browser: ["Mac OS", "Chrome", "114.0.5735.198"]
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            QRCode.toDataURL(qr, (err, url) => {
                qrCodeImage = url;
                console.log("✅ تم إنشاء رمز QR جديد");
            });
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            qrCodeImage = "DONE";
        }
    });

    // كود جيمني (العقل)
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
    res.setHeader('Refresh', '5'); // تحديث تلقائي كل 5 ثواني
    if (qrCodeImage === "DONE") return res.send("<h1>✅ تم الربط! البوت يعمل الآن.</h1>");
    if (qrCodeImage) return res.send(`<h1>امسح الرمز الآن:</h1><br><img src="${qrCodeImage}" style="width:300px; border: 5px solid #000;"/><p>سيختفي هذا الرمز بمجرد المسح.</p>`);
    res.send("<h1>جاري الاتصال بسيرفرات واتساب... الصفحة ستحدث نفسها، انتظر ثواني فقط.</h1>");
});

app.listen(port, () => {
    console.log(`Server started on port ${port}`);
    startBot();
});
