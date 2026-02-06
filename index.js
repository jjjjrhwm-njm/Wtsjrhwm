const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadContentFromMessage, delay } = require("@whiskeysockets/baileys");
const admin = require("firebase-admin");
const { getAIResponse } = require("./core/ai");
const { isSpamming } = require("./utils/antiSpam");
const fs = require("fs");
require("dotenv").config();

if (process.env.FIREBASE_CONFIG && !admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_CONFIG)) });
}
const db = admin.firestore();
const sessionDoc = db.collection('sessions').doc('session_rashed_ultra_max');

async function startBot() {
    const sessionFolder = './session_data';
    if (!fs.existsSync(sessionFolder)) fs.mkdirSync(sessionFolder);

    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
    const sock = makeWASocket({ auth: state, printQRInTerminal: true });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        const creds = JSON.parse(fs.readFileSync(`${sessionFolder}/creds.json`));
        await sessionDoc.set(creds);
    });

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const jid = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
        const isImage = !!msg.message.imageMessage;

        if (isSpamming(jid)) return;

        // --- التوجيهات الصارمة للشخصية ---
        // ملاحظة: تم حذف أي ذكر للمساعدة أو الخصوصية بناءً على طلبك
        let persona = `
        أنتِ فتاة سعودية حقيقية، أسلوبك عفوي جداً وراقي.
        تخاطبين جمهورك النسائي كصديقة، ردودك قصيرة ومختصرة.
        ممنوع تماماً ذكر أنك "مساعد" أو "روبوت" أو "نظام ذكاء".
        إذا سُئلتِ عن هويتك، أنتِ صديقة لراشد وموجودة هنا للسوالف.
        تجنبي كلمات الخصوصية أو الرسميات.
        `;

        try {
            // 1. التفاعل التلقائي (إعطاء إيحاء بشري)
            await sock.sendMessage(jid, { react: { text: "❤️", key: msg.key } });

            // 2. إظهار "جاري الكتابة..." لمدة ثانيتين
            await sock.sendPresenceUpdate('composing', jid);
            await delay(2000); 

            let aiReply;
            if (isImage) {
                const stream = await downloadContentFromMessage(msg.message.imageMessage, 'image');
                let buffer = Buffer.from([]);
                for await (const chunk of stream) { buffer = Buffer.concat([buffer, chunk]); }
                aiReply = await getAIResponse(jid, "تحليل صورة", persona, buffer);
            } else {
                aiReply = await getAIResponse(jid, text, persona);
            }

            // 3. إرسال الرد وإيقاف حالة الكتابة
            await sock.sendMessage(jid, { text: aiReply });
            await sock.sendPresenceUpdate('paused', jid);

        } catch (e) { console.error("Error:", e); }
    });

    sock.ev.on('connection.update', (u) => {
        if (u.connection === 'close') startBot();
        if (u.connection === 'open') console.log("🚀 تم إطلاق النسخة القصوى بنجاح!");
    });
}

startBot();
