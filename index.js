const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, jidNormalizedUser } = require("@whiskeysockets/baileys");
const admin = require("firebase-admin");
const express = require("express");
const QRCode = require("qrcode");
const Groq = require("groq-sdk");
const fs = require("fs");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 10000;
let qrCodeImage = "";
let db;
let sock;

const OWNER_NUMBER  = (process.env.OWNER_NUMBER  || "966554526287") + "@s.whatsapp.net";
const WIFE_NUMBER   = (process.env.WIFE_NUMBER   || "967782203551") + "@s.whatsapp.net";
const WIFE2_NUMBER  = (process.env.WIFE2_NUMBER  || "966599741982") + "@s.whatsapp.net";
const FATHER_NUMBER = (process.env.FATHER_NUMBER || "967783015253") + "@s.whatsapp.net";

let isBotActive = true;
let currentlyReplyingTo = null;
let ownerResponse = null;
const chatSessions = {};

// ────────────────────────────────────────────────
//          تعديل التعليمات (SYSTEM PROMPT) لتبدو بشرية ومختصرة
// ────────────────────────────────────────────────
const SILIA_CORE_PERSONA = `
أنتِ "سيليا"، تديرين تواصل راشد حالياً.
الأسلوب: سعودي، رسمي، حقيقي، وتفاعلي.
القاعدة الذهبية: الاختصار الشديد (الزبدة). الرد لا يتجاوز جملة واحدة قصيرة غالباً.

المهام:
- ردي بذكاء رسمي: "هلا، راشد مشغول حالياً.. وش الرسالة اللي أوصلها له؟".
- لا تكرري نفس الصيغة. إذا استمر الشخص بالكلام، ردي بعبارات تفاعلية قصيرة: "تمام سجلت"، "أوكي ببلغه"، "وصلت".
- تجنبي الأسلوب الآلي تماماً. كوني بشرية خلف الشاشة.

المحادثة:
{{HISTORY}}
`;

const SPECIAL_PROMPTS = {
  [WIFE_NUMBER]:   "أنت راشد، رد على زوجتك الأولى بحنان سعودي واقعي ومختصر جداً.",
  [WIFE2_NUMBER]:  "أنت راشد، رد على زوجتك الثانية بدلع خفيف وحنان، مختصر جداً.",
  [FATHER_NUMBER]: "أنت راشد، رد على أبوك باحترام كامل وأدب، ردود قصيرة (سم، أبشر، تم).",
};

const ANGRY_SILIA = `أنتِ سيليا، ردي بحزم سعودي مختصر: "عفواً، احترم نفسك." أو "ما أقبل هالكلام." ثم توقفي.`;

// ────────────────────────────────────────────────
//                   Firebase functions
// ────────────────────────────────────────────────
// ضع دوال Firebase الخاصة بك هنا كما هي

async function startBot() {
  if (!fs.existsSync('./auth_info')) fs.mkdirSync('./auth_info');

  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ["Mac OS", "Chrome", "128.0.0.0"] // الهوية ثابتة لعدم طلب QR
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', update => {
    if (update.qr) QRCode.toDataURL(update.qr, (_, url) => qrCodeImage = url);
    if (update.connection === 'open') qrCodeImage = "CONNECTED";
    if (update.connection === 'close') startBot();
  });

  sock.ev.on('messages.upsert', async evt => {
    const msg = evt.messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const remoteJid = jidNormalizedUser(msg.key.remoteJid);
    let text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
    text = text.trim();
    if (!text) return;

    if (remoteJid === OWNER_NUMBER) {
      if (["إيقاف", "تفعيل", "تصفير0", "موافق", "رفض"].includes(text)) {
        // معالجة الأوامر
      }
    }

    if (!isBotActive) return;

    if (!chatSessions[remoteJid]) {
      chatSessions[remoteJid] = { history: [], firstContact: true };
    }

    const session = chatSessions[remoteJid];
    let historyText = session.history.slice(-5).map(m => m.content).join("\n");
    let system = SILIA_CORE_PERSONA.replace("{{HISTORY}}", historyText || "(بداية)");

    if (SPECIAL_PROMPTS[remoteJid]) system = SPECIAL_PROMPTS[remoteJid];
    if (!Object.keys(SPECIAL_PROMPTS).includes(remoteJid) && remoteJid !== OWNER_NUMBER) {
      if (/(أحبك|عسل|روحي|بوس|دلع|جميلة|رومانس)/gi.test(text)) system = ANGRY_SILIA;
    }

    let response = "";
    try {
      const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
      const completion = await groq.chat.completions.create({
        messages: [
          { role: "system", content: system },
          ...session.history.slice(-6),
          { role: "user", content: text }
        ],
        model: "llama-3.1-70b-versatile", 
        temperature: 0.8, // تم تعديل الحرارة لتوازن بشري (واقعي وغير عشوائي)
        top_p: 0.9,
        max_tokens: 50, // إجبار على الاختصار الشديد
        frequency_penalty: 0.5,
        presence_penalty: 0.3,
      });

      response = completion.choices[0]?.message?.content?.trim() || "تمام، ببلغه.";
    } catch (err) {
      console.error(err);
      response = session.firstContact ? "هلا، راشد مشغول الحين.. وش أوصله؟" : "تمام، سجلت عندي.";
    }

    await sock.sendMessage(remoteJid, { text: response });

    session.history.push({ role: "user", content: text }, { role: "assistant", content: response });
    if (session.history.length > 10) session.history = session.history.slice(-10);
    session.firstContact = false;
  });
}

app.get("/", (_, res) => {
  if (qrCodeImage === "CONNECTED") return res.send("<h1>متصل ✓</h1>");
  if (qrCodeImage) return res.send(`<img src="${qrCodeImage}" width="300"/>`);
  res.send("<h1>جاري الاتصال...</h1>");
});

app.listen(port, () => startBot());
