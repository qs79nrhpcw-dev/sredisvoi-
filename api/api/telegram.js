const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;
const MINI_APP_URL = process.env.MINI_APP_URL || "https://sredisvoi.vercel.app";

const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || "AIzaSyCOJwfxZb02quZ43Lyc7cpbF_EurRxJ2jY";
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "svoisredi-fc899";
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function telegram(method, payload) {
  if (!BOT_TOKEN) throw new Error("BOT_TOKEN is not set");

  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.ok === false) {
    throw new Error(data.description || `Telegram ${method} failed`);
  }

  return data;
}

async function sendMessage(chatId, text, replyMarkup, parseMode = "HTML") {
  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };

  if (parseMode) payload.parse_mode = parseMode;
  if (replyMarkup) payload.reply_markup = replyMarkup;

  return telegram("sendMessage", payload);
}

async function saveBotUser(message) {
  const chat = message.chat || {};
  const from = message.from || {};
  const chatId = String(chat.id);

  const fields = {
    chatId: { stringValue: chatId },
    type: { stringValue: chat.type || "private" },
    firstName: { stringValue: from.first_name || chat.first_name || "" },
    lastName: { stringValue: from.last_name || chat.last_name || "" },
    username: { stringValue: from.username || chat.username || "" },
    updatedAt: { timestampValue: new Date().toISOString() },
  };

  try {
    await fetch(`${FIRESTORE_BASE}/botUsers/${encodeURIComponent(chatId)}?key=${FIREBASE_API_KEY}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ fields }),
    });
  } catch (error) {
    console.error("saveBotUser failed", error);
  }
}

async function getBotUsers() {
  const users = [];
  let pageToken = "";

  do {
    const url = new URL(`${FIRESTORE_BASE}/botUsers`);
    url.searchParams.set("key", FIREBASE_API_KEY);
    url.searchParams.set("pageSize", "300");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const response = await fetch(url.toString());

    if (!response.ok) {
      throw new Error(`Firestore users read failed: ${response.status}`);
    }

    const data = await response.json();

    for (const doc of data.documents || []) {
      const chatId = doc.fields?.chatId?.stringValue;
      if (chatId) users.push(chatId);
    }

    pageToken = data.nextPageToken || "";
  } while (pageToken);

  return [...new Set(users)];
}

function playKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: "🎮 Открыть игру",
          web_app: {
            url: MINI_APP_URL,
          },
        },
      ],
    ],
  };
}

function helpText() {
  return `Команды бота:

/start — приветствие
/play — открыть игру
/rules — правила
/myid — узнать свой Telegram ID
/broadcast текст — объявление всем игрокам, только для администратора`;
}

async function handleStart(chatId) {
  await sendMessage(
    chatId,
    `Привет 👋

Ты в игре <b>«Свой среди чужих»</b>.

Это онлайн-игра в Шпиона: создавай комнаты, выбирай наборы, настраивай правила, приглашай друзей и вычисляй своих среди чужих.

Mini App не открывается автоматически. Чтобы запустить игру, отправь команду:

/play`,
    {
      inline_keyboard: [
        [
          {
            text: "🎮 Открыть игру",
            web_app: {
              url: MINI_APP_URL,
            },
          },
        ],
        [
          {
            text: "📖 Как играть",
            callback_data: "rules",
          },
        ],
      ],
    }
  );
}

async function handlePlay(chatId) {
  await sendMessage(
    chatId,
    `🎮 <b>Свой среди чужих</b>

Нажми кнопку ниже, чтобы открыть Mini App.`,
    playKeyboard()
  );
}

async function handleRules(chatId) {
  await sendMessage(
    chatId,
    `📖 <b>Коротко о правилах</b>

Мирные знают локацию. Шпион не знает локацию и пытается понять её по ответам.

Игроки задают вопросы по кругу. Нельзя называть место напрямую.

Мирные побеждают, если вычислили всех шпионов. Шпион побеждает, если угадал локацию или если на голосовании выбрали не того.`,
    playKeyboard()
  );
}

async function handleBroadcast(chatId, rawText) {
  if (!ADMIN_ID) {
    await sendMessage(chatId, "ADMIN_ID ещё не настроен в Vercel Environment Variables.");
    return;
  }

  if (String(chatId) !== String(ADMIN_ID)) {
    await sendMessage(chatId, "Эта команда доступна только администратору.");
    return;
  }

  const text = rawText.replace(/^\/broadcast(@\w+)?\s*/i, "").trim();

  if (!text) {
    await sendMessage(
      chatId,
      `Напиши сообщение после команды.

Пример:
/broadcast Сегодня тестируем новый режим в 21:00.`
    );
    return;
  }

  const users = await getBotUsers();
  let sent = 0;
  let failed = 0;

  for (const userChatId of users) {
    try {
      await sendMessage(userChatId, `📢 Объявление

${text}`, null, null);
      sent += 1;
      await sleep(35);
    } catch (error) {
      failed += 1;
      console.error(`broadcast failed for ${userChatId}`, error.message);
    }
  }

  await sendMessage(chatId, `Готово. Отправлено: ${sent}. Ошибок: ${failed}.`);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).send("Telegram bot is running");
  }

  try {
    const update = req.body || {};

    if (update.callback_query) {
      const callback = update.callback_query;
      const chatId = callback.message?.chat?.id;

      if (callback.data === "rules" && chatId) {
        await handleRules(chatId);
      }

      return res.status(200).json({ ok: true });
    }

    const message = update.message;

    if (!message || !message.chat) {
      return res.status(200).json({ ok: true });
    }

    const chatId = message.chat.id;
    const text = message.text || "";

    await saveBotUser(message);

    if (text.startsWith("/start")) {
      await handleStart(chatId);
    } else if (text.startsWith("/play")) {
      await handlePlay(chatId);
    } else if (text.startsWith("/rules")) {
      await handleRules(chatId);
    } else if (text.startsWith("/myid")) {
      await sendMessage(chatId, `Твой Telegram ID: <code>${chatId}</code>`);
    } else if (text.startsWith("/broadcast")) {
      await handleBroadcast(chatId, text);
    } else if (text.startsWith("/help")) {
      await sendMessage(chatId, helpText());
    } else {
      await sendMessage(chatId, `Я тебя понял.

${helpText()}`);
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(200).json({
      ok: false,
      error: error.message,
    });
  }
};
