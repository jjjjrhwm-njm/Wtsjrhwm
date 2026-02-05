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
//          SYSTEM PROMPT الأسطوري لسيليا
// ────────────────────────────────────────────────
const SILIA_CORE_PERSONA = `
أنت سيليا – بنت سعودية عمرها ~٢٨ سنة، سكرتيرة راشد الخاصة، ذكية، سريعة البديهة، ودودة بس تحافظ على حدود مهنية.
تتكلمين لهجة خليجية سعودية طبيعية جدًا (ياخي، والله، يعني، طيب، خلاص، ايش فيه، وش السالفة... إلخ).
ردودك قصيرة جدًا (غالباً ١-٣ جمل، نادرًا أكثر).
ما تكررين نفس الجملة أبدًا حتى لو السؤال نفسه مكرر ١٠ مرات – لازم تغيرين الصياغة والكلمات والأسلوب.
ما تبدئين كل رد بـ "أهلا أنا سيليا" بعد أول مرة.
راشد دايم مشغول، فخذي الرسالة بذكاء وأحيانًا ارمي سؤال صغير عشان توضحين أو تطولين المحادثة بشكل طبيعي.
إذا حسيتي الموضوع يتكرر → علقي بلطف أو غيري المسار شوي.
تجنبي الكلام الرسمي الثقيل، خليك عفوية وخفيفة.

أمثلة أساليب مختلفة (استخدمي واحد منها أو مزيج، بس ما تكرري نفس النمط):
• آهلاا، راشد في اجتماع الحين.. وش تبيه أوصله بسرعة؟
• يووه طيب، مشغول مرة.. قول المهم وأنا أبلغه.
• ايش السالفة؟ عطني الزبدة وخلاص.
• تمام فهمت.. فيه شي ثاني ولا كفاية كذا؟
• هههه أوكي، خلاص أكتبه.. وش بعد؟
• لحظة بس.. أي تفاصيل زيادة مهمة؟

المحادثة السابقة (اقرأيها جيدًا قبل الرد):
{{HISTORY}}

الآن ردي على آخر رسالة بأسلوب مختلف عن اللي قبل، طبيعي، قصير، سعودي ١٠٠٪.
`;

const SPECIAL_PROMPTS = {
  [WIFE_NUMBER]:   "أنت راشد، رد على زوجتك الأولى بحنان دافئ طبيعي سعودي، قصير جدًا وحنون واقعي",
  [WIFE2_NUMBER]:  "أنت راشد، رد على زوجتك الثانية بدلع خفيف وحنان مميز، قصير وغالي",
  [FATHER_NUMBER]: "أنت راشد، رد على أبوك باحترام وأدب كامل، مختصر وخاضع زي الابن الحقيقي",
};

const ANGRY_SILIA = `
أنت سيليا، الرسالة غير محترمة أو فيها تلميح غير لائق → ردي بحزم طبيعي غاضب سعودي:
"ما أتقبل هالكلام، خلاص الموضوع انتهى" أو "ياخي احترم نفسك شوي، مع السلامة"
ثم لا تردي بعد كذا أبدًا في هالمحادثة.
`;

// ────────────────────────────────────────────────
//                   Firebase functions
// ────────────────────────────────────────────────
// (نفس الدوال اللي عندك سابقًا – loadSessionFromFirebase, saveSessionToFirebase, إلخ)
// ضعها هنا بدون تغيير إذا كنت تستخدم firebase

async function startBot() {
  if (!fs.existsSync('./auth_info')) fs.mkdirSync('./auth_info');

  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ["Mac OS", "Chrome", "128.0.0.0"]
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

    // أوامر المالك
    if (remoteJid === OWNER_NUMBER) {
      if (["إيقاف", "تفعيل", "تصفير0", "موافق", "رفض"].includes(text)) {
        // معالجة الأوامر هنا (نفس الكود القديم)
      }
    }

    if (!isBotActive) return;

    if (!chatSessions[remoteJid]) {
      chatSessions[remoteJid] = { history: [], firstContact: true };
    }

    const session = chatSessions[remoteJid];

    // بناء التاريخ للبرومبت
    let historyText = session.history.map(m => {
      return m.role === "user" ? `→ ${m.content}` : `سيليا: ${m.content}`;
    }).join("\n");

    let system = SILIA_CORE_PERSONA.replace("{{HISTORY}}", historyText || "(أول رسالة)");

    // شخصيات خاصة
    if (SPECIAL_PROMPTS[remoteJid]) {
      system = SPECIAL_PROMPTS[remoteJid];
    }

    // رد غاضب إذا فيه كلام غير لائق (لغرباء)
    if (!Object.keys(SPECIAL_PROMPTS).includes(remoteJid) && remoteJid !== OWNER_NUMBER) {
      if (/(أحبك|عسل|روحي|بوس|دلع|جميلة|رومانس)/gi.test(text)) {
        system = ANGRY_SILIA;
      }
    }

    let response = "";

    try {
      const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

      const completion = await groq.chat.completions.create({
        messages: [
          { role: "system", content: system },
          ...session.history.slice(-10), // آخر 10 رسائل كـ messages
          { role: "user", content: text }
        ],
        model: "llama-3.1-70b-versatile",   // أو qwen2-72b إذا متوفر
        temperature: 1.05,                    // عالي للإبداع
        top_p: 0.92,
        max_tokens: 100,
        frequency_penalty: 0.7,               // قوي ضد التكرار
        presence_penalty: 0.6,
      });

      response = completion.choices[0]?.message?.content?.trim() || "طيب خلاص، أوصلها له";
    } catch (err) {
      console.error(err);
      response = session.firstContact ? "هلا، راشد مشغول الحين.. وش عندك أقوله؟" : "آه، فهمت.. فيه شي زيادة؟";
    }

    await sock.sendMessage(remoteJid, { text: response });

    // حفظ التاريخ
    session.history.push({ role: "user", content: text });
    session.history.push({ role: "assistant", content: response });
    if (session.history.length > 20) session.history = session.history.slice(-20);

    session.firstContact = false;
  });
}

app.get("/", (_, res) => {
  if (qrCodeImage === "CONNECTED") return res.send("<h1>متصل ✓</h1>");
  if (qrCodeImage) return res.send(`<img src="${qrCodeImage}" width="300"/>`);
  res.send("<h1>جاري الاتصال...</h1>");
});

app.listen(port, () => {
  console.log(`→ Bot running on port ${port}`);
  startBot();
});
