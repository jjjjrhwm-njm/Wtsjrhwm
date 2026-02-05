// ... (الأجزاء الأولى من الكود كما هي تماماً لضمان عدم طلب QR)

// ────────────────────────────────────────────────
//          قائمة ردود "بشرية" عشوائية لو تعطل الـ AI
// ────────────────────────────────────────────────
const HUMAN_FALLBACKS = [
  "تمام، ببلغه أول ما يخلص.",
  "أوكي سجلت رسالتك.. فيه شي ثاني؟",
  "وصلت، بشوف وش يقول وأرد لك خبر.",
  "فهمتك، بس راشد الحين مو حول الجوال.. تبغى شي غيره؟",
  "خلاص تمام، أكتبها له الحين.",
  "ماشي، أول ما يرجع بيشوفها أكيد."
];

const SILIA_CORE_PERSONA = `
أنت سيليا - بنت سعودية حقيقية، تديرين مكتب راشد.
ممنوع تقولين "أنا ذكاء اصطناعي" أو "أنا بوت".
راشد مشغول جداً، ردي بلهجة سعودية (بيضاء) رسمية ومحترمة بس "بشرية".
الاختصار هو أهم شيء: (ردودك لا تزيد عن ٥-٧ كلمات).
ممنوع تكرار نفس الأسلوب. كوني "خدومة" وبشرية.

المحادثة:
{{HISTORY}}
`;

// ... (دوال Firebase والمحرك كما هي)

  sock.ev.on('messages.upsert', async evt => {
    const msg = evt.messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const remoteJid = jidNormalizedUser(msg.key.remoteJid);
    let text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
    text = text.trim();
    if (!text) return;

    if (!isBotActive) return;

    if (!chatSessions[remoteJid]) {
      chatSessions[remoteJid] = { history: [], firstContact: true };
    }
    const session = chatSessions[remoteJid];

    let historyText = session.history.slice(-5).map(m => m.content).join("\n");
    let system = SILIA_CORE_PERSONA.replace("{{HISTORY}}", historyText || "(بداية)");

    // الردود الخاصة والتحقق من الأدب (تبقى كما هي في كودك)

    let response = "";
    try {
      const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
      const completion = await groq.chat.completions.create({
        messages: [
          { role: "system", content: system },
          ...session.history.slice(-6), 
          { role: "user", content: text }
        ],
        model: "llama-3.3-70b-versatile", // تحديث الموديل لأداء أفضل
        temperature: 0.8, // زيادة العفوية قليلاً
        max_tokens: 50, // إجبار على الاختصار الشديد
      });

      response = completion.choices[0]?.message?.content?.trim();
    } catch (err) {
      // هنا الحل! لو فشل الـ AI يختار رد عشوائي بشري بدلاً من التكرار
      response = HUMAN_FALLBACKS[Math.floor(Math.random() * HUMAN_FALLBACKS.length)];
    }

    if (response) {
      await sock.sendMessage(remoteJid, { text: response });
      session.history.push({ role: "user", content: text }, { role: "assistant", content: response });
      if (session.history.length > 10) session.history.shift();
    }
  });

// ... (باقي الكود كما هو تماماً)
