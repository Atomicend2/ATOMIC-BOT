// index.js
// Atomic WhatsApp Bot - Uses Baileys with a Base64 session string for persistence

// --- CORRECTED BAILEYS IMPORTS ---
// makeWASocket and other core functions are now directly named imports from @whiskeysockets/baileys
import { makeWASocket, Browsers, DisconnectReason, delay, downloadContentFromMessage } from '@whiskeysockets/baileys';
// --- END CORRECTED IMPORTS ---

import pino from 'pino';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Buffer } from 'buffer'; // Needed for Base64 decoding

dotenv.config();

// Baileys Logger - Set to 'info' or 'debug' for more verbose output
const logger = pino({ level: 'info' }).child({ level: 'info', stream: 'process.stdout' });

// Initialize Google Gemini AI
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
    console.error('ERROR: GEMINI_API_KEY not found in .env file. Please get one from Google AI Studio.');
    process.exit(1);
}
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-pro" });

// --- Custom Auth State for Base64 Session String ---
// This is a simplified version of Baileys' authState for single ENV var storage.
function useBase64AuthState() {
    const sessionString = process.env.BAILEYS_SESSION;
    let creds;
    let keys = {};

    if (sessionString) {
        try {
            // Decode the Base64 string and parse the JSON
            const decodedString = Buffer.from(sessionString, 'base64').toString('utf8');
            const sessionData = JSON.parse(decodedString);
            creds = sessionData.creds;
            keys = sessionData.keys; // Ensure keys are loaded too
            logger.info('✅ Successfully loaded session from BAILEYS_SESSION environment variable.');
        } catch (e) {
            logger.error('🚨 Error parsing BAILEYS_SESSION environment variable:', e);
            logger.warn('Falling back to new authentication (this will require a new pair code).');
            creds = null; // Force new authentication
            keys = {};
        }
    } else {
        logger.warn('BAILEYS_SESSION environment variable not found. A new session will be generated.');
        creds = null; // Force new authentication
        keys = {};
    }

    // Function to update and save credentials (this will print the NEW Base64 string if session changes)
    const saveCreds = () => {
        const newSessionData = { creds, keys };
        const newSessionString = Buffer.from(JSON.stringify(newSessionData)).toString('base64');
        logger.info('\n--- NEW BAILEYS SESSION STRING ---');
        logger.info('If your bot just authenticated or session changed, UPDATE your Render BAILEYS_SESSION ENV variable with this:');
        logger.info(newSessionString);
        logger.info('----------------------------------\n');
    };

    // Return the structure expected by Baileys for the 'auth' option
    return {
        state: {
            creds,
            keys: {
                get: (type, ids) => {
                    const data = keys[type];
                    if (data) {
                        const result = {};
                        for (const id of ids) {
                            result[id] = data[id]; // Direct access, Baileys handles Buffer conversion
                        }
                        return result;
                    }
                    return {};
                },
                set: (data) => {
                    for (const _key in data) {
                        keys[_key] = keys[_key] || {};
                        Object.assign(keys[_key], data[_key]);
                    }
                    saveCreds(); // Save whenever keys change
                },
                del: (type, ids) => {
                    const data = keys[type];
                    if (data) {
                        for (const id of ids) {
                            delete data[id];
                        }
                        saveCreds(); // Save after deleting
                    }
                }
            }
        },
        saveCreds
    };
}


// --- Baileys Connection Logic ---
async function startAtomicBot() {
    const { state, saveCreds } = useBase64AuthState(); // Use our custom Base64 auth state

    const sock = makeWASocket({
        auth: state,
        browser: Browsers.macOS('Chrome'), // Simulates a desktop browser for connection
        logger: logger,
        shouldSyncHistoryMessage: true,
        getMessage: async (key) => {
            // Function to retrieve messages needed by Baileys (e.g., for quoting)
            return null; // For simple bots, returning null is often fine.
        }
    });

    // Event: Connection Update
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
            logger.info('Connection closed due to ', lastDisconnect?.error, '. Reconnecting: ', shouldReconnect);

            if (lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut) {
                logger.info('Session logged out! You need to get a new BAILEYS_SESSION string. The bot will exit. Run locally to re-authenticate or check Render logs for a new code.');
                // Here, the bot should exit to allow Render to restart it, leading to a new pair code request.
                process.exit(0);
            } else if (shouldReconnect) {
                await delay(5000); // Wait 5 seconds before attempting to reconnect
                startAtomicBot(); // Attempt to reconnect
            }
        } else if (connection === 'open') {
            logger.info('✅ Atomic is online and ready for action! Get ready for some anime magic! ✨');
            logger.info('Type !help or !commands to see what Atomic can do. Nani?!');
        }
    });

    // Event: Credentials Update (Important for persistent session)
    // This will trigger our custom saveCreds function, printing a new Base64 string if session changes.
    sock.ev.on('creds.update', saveCreds);

    // Initial Pairing Code Generation (ONLY if not already authenticated by session string)
    // This part runs IF BAILEYS_SESSION is missing or invalid.
    if (!sock.authState.creds || !sock.authState.creds.registered && !sock.user) { // Corrected robustness check
        logger.info('\n🚨 No valid session found! Generating a new pairing code. 🚨');
        logger.info('You will need to manually enter your phone number in Render logs or set PHONE_NUMBER env variable for auto-pairing.');

        // Prompt for phone number to get pairing code
        const phoneNumber = process.env.PHONE_NUMBER; // Try getting from ENV
        if (phoneNumber) {
            logger.info(`Attempting to request pairing code for phone number: ${phoneNumber}`);
            await delay(3000); // Give Baileys a moment to be ready
            try {
                const code = await sock.requestPairingCode(phoneNumber);
                logger.info(`\n🔑 Your Baileys Pair Code (valid for ~90 seconds): ${code}\n`);
                logger.info('On your phone: Go to WhatsApp > Settings > Linked Devices > Link a Device > Link with phone number. Then enter this code.');
                logger.info('Once connected, a NEW BAILEYS_SESSION string will be printed. Update your Render ENV with it!');
            } catch (error) {
                logger.error('Failed to request pairing code:', error);
                logger.error('This might happen if the phone number is invalid, or if WhatsApp is rate-limiting.');
            }
        } else {
            logger.error('ERROR: No BAILEYS_SESSION and PHONE_NUMBER environment variable is NOT set. Cannot generate pairing code automatically. Please set PHONE_NUMBER on Render.');
        }
    }


    // Event: Messages Received
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return; // Ignore empty messages
        if (msg.key.fromMe) return; // Ignore messages sent by the bot itself

        const from = msg.key.remoteJid; // Sender's JID
        const type = Object.keys(msg.message)[0]; // Get message type (e.g., conversation, imageMessage)
        const body = (type === 'conversation' && msg.message.conversation) ||
                     (type === 'imageMessage' && msg.message.imageMessage.caption) ||
                     (type === 'videoMessage' && msg.message.videoMessage.caption) ||
                     ''; // Extract text body

        const isGroup = from.endsWith('@g.us'); // Check if it's a group chat

        logger.info(`[${isGroup ? 'GROUP' : 'PRIVATE'}] ${from}: ${body}`);

        const messageBody = body.toLowerCase().trim();

        // --- Utility Commands ---
        if (messageBody === '!ping') {
            await sock.sendMessage(from, { text: 'Pong! Atomic is super responsive! 💨' });
        } else if (messageBody === '!commands' || messageBody === '!help') {
            let helpMessage = `
🌟 **Atomic Bot Commands ⚛️** 🌟

*Ah, an adventurer seeking knowledge! Here are some of Atomic's powerful features:*

**📖 Anime & Manga Tools:**
* \`!waifu\` / \`!husbando\` - Get a random, high-quality anime character image!
* \`!anime <title>\` - Search for anime details from MyAnimeList/AniList.
* \`!manga <title>\` - Search for manga details from MyAnimeList/AniList.
* \`!quote\` - Get a random iconic anime or philosophical quote.

**🎮 Interactive Entertainment:**
* \`!chat <your message>\` - Talk to Atomic's AI in a cute anime style!
* \`!trivia\` - Start an anime trivia game! (Coming Soon!)
* \`!gacha\` - Pull for a random virtual item/character! (Coming Soon!)
* \`!avatar <photo>\` - Turn your selfie into an anime avatar! (Attach photo)
* \`!sticker <photo/video>\` - Make a custom sticker from media! (Attach photo/video)

**🔧 Utility & Moderation (for Group Managers):**
* \`!welcome <message>\` - Set an auto-welcome message for new members. (Group Admin Only)
* \`!spamguard on/off\` - Toggle anti-spam protection. (Group Admin Only)
* \`!download <youtube/soundcloud link>\` - Fetch anime OSTs, AMVs, or memes.

**🎨 Customization & Fun Extras:**
* \`!settheme <color/theme>\` - Change Atomic's UI colors/themes (conceptual for future UI integration).
* \`!waifurpg\` - Begin your journey to collect, train, and battle waifus! (Coming Soon!)
* \`!say <text>\` - Atomic will send a voice message with an anime voice filter! (Coming Soon!)

_Nani?! That's impossible! So many features!_
            `;
            await sock.sendMessage(from, { text: helpMessage });
        }

        // --- AI Chat Mode ---
        if (messageBody.startsWith('!chat ')) {
            const userMessage = body.substring('!chat '.length).trim();
            if (userMessage) {
                try {
                    const result = await model.generateContent(`You are Atomic, a playful, witty, and occasionally dramatic anime protagonist chatbot. Your responses should include anime references and feel vibrant and futuristic. Respond to the user's message: "${userMessage}"`);
                    const response = result.response;
                    const text = response.text();
                    await sock.sendMessage(from, { text: `*Atomic says:* ${text}` });
                } catch (error) {
                    logger.error('Gemini AI Error:', error);
                    await sock.sendMessage(from, { text: 'Baka! Atomic is having a momentary system glitch! Please try again later. 💢' });
                }
            } else {
                await sock.sendMessage(from, { text: 'Hey! You need to give Atomic something to chat about! Try `!chat Hello, Atomic!`' });
            }
        }

        // --- Image/Sticker Maker ---
        if ((type === 'imageMessage' || type === 'videoMessage') && (messageBody === '!sticker' || messageBody === '!avatar')) {
            try {
                const mediaMessage = msg.message.imageMessage || msg.message.videoMessage;
                const buffer = await downloadContentFromMessage(mediaMessage, type.replace('Message', ''));

                if (messageBody === '!sticker') {
                    await sock.sendMessage(from, { sticker: buffer });
                    await sock.sendMessage(from, { text: 'Sticker transformation complete! Kawaii! ✨' });
                }
                if (messageBody === '!avatar') {
                    await sock.sendMessage(from, { text: 'Transforming your selfie into an anime avatar! This might take a moment, senpai! (Feature under construction, but imagine the possibilities! 🎨)' });
                }
            } catch (error) {
                logger.error('Media processing error:', error);
                await sock.sendMessage(from, { text: 'My circuits are a bit fried trying to process that! Try another image. 💢' });
            }
        }

        // --- Placeholder for other features ---
        if (messageBody.startsWith('!anime ')) {
            const query = body.substring('!anime '.length).trim();
            await sock.sendMessage(from, { text: `Searching for anime: "${query}"... (This feature will fetch details from MyAnimeList/AniList! Stay tuned!) 📚` });
        }

        if (messageBody.startsWith('!manga ')) {
            const query = body.substring('!manga '.length).trim();
            await sock.sendMessage(from, { text: `Searching for manga: "${query}"... (This feature will fetch details from MyAnimeList/AniList! Read on, otaku!) 📖` });
        }

        if (messageBody === '!waifu') {
            const waifuImages = [
                'https://raw.githubusercontent.com/AnshulRaut/waifu-pics-api/main/images/waifu/1.jpg',
                'https://raw.githubusercontent.com/AnshulRaut/waifu-pics-api/main/images/waifu/2.jpg',
                'https://raw.githubusercontent.com/AnshulRaut/waifu-pics-api/main/images/waifu/3.jpg'
            ];
            const randomWaifu = waifuImages[Math.floor(Math.random() * waifuImages.length)];
            await sock.sendMessage(from, { image: { url: randomWaifu }, caption: 'Behold! Your magnificent waifu! ✨' });
        }

        if (messageBody === '!husbando') {
            const husbandoImages = [
                'https://raw.githubusercontent.com/AnshulRaut/waifu-pics-api/main/images/husbando/1.jpg',
                'https://raw.githubusercontent.com/AnshulRaut/waifu-pics-api/main/images/husbando/2.jpg'
            ];
            const randomHusbando = husbandoImages[Math.floor(Math.random() * husbandoImages.length)];
            await sock.sendMessage(from, { image: { url: randomHusbando }, caption: 'A true husbando has arrived! Strong and dependable! 💪' });
        }

        if (messageBody === '!quote') {
            const animeQuotes = [
                "\"The world isn't perfect. But it's there for us, doing the best it can... that's what makes it so damn beautiful.\" - Roy Mustang, Fullmetal Alchemist ⚛️",
                "\"If you don't take risks, you can't create a future.\" - Monkey D. Luffy, One Piece 🏴‍☠️",
                "\"People who can't throw something important away, can never hope to change anything.\" - Armin Arlert, Attack on Titan 🗡️",
                "\"The moment you think of giving up, think of the reason why you held on so long.\" - Natsu Dragneel, Fairy Tail 🔥",
                "\"Fear is not evil. It tells you what your weakness is. And once you know your weakness, you can become stronger as well.\" - Gildarts Clive, Fairy Tail ✨"
            ];
            const randomQuote = animeQuotes[Math.floor(Math.random() * animeQuotes.length)];
            await sock.sendMessage(from, { text: `*Atomic's Wisdom:* "${randomQuote}"` });
        }
    });
}

// Start the bot
startAtomicBot();
        
