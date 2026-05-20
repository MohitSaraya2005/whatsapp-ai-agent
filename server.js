import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import { connectDB, ChatSession } from './db.js';

connectDB().catch(err => console.error("Database connection failure:", err));

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MO_VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// Initialize the Gemini AI Client
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// 1. Webhook Verification (GET)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === MO_VERIFY_TOKEN) {
    process.stdout.write('Webhook verified successfully!\n');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// 2. Handle Incoming Messages (POST)
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const body = req.body;

  if (body.object === 'whatsapp_business_account' && body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
    const messageObj = body.entry[0].changes[0].value.messages[0];
    const from = messageObj.from; 
    const messageText = messageObj.text?.body; 

    if (messageText) {
      try {
        // 1. Fetch existing session log or build a new one inline
        let session = await ChatSession.findOne({ whatsappNumber: from });
        if (!session) {
          session = new ChatSession({ whatsappNumber: from, history: [] });
        }

        // 2. Append the incoming message 
        session.history.push({ role: 'user', parts: [{ text: messageText }] });

        let aiReply = "";
        const modelsToTry = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-1.5-flash'];

        for (const modelName of modelsToTry) {
          try {
            // 3. Feed the database history straight to Gemini
            const response = await ai.models.generateContent({
              model: modelName,
              contents: session.history, 
              config: {
                systemInstruction: "You are a helpful, concise AI assistant communicating over WhatsApp.",
              }
            });

            if (response.text) {
              aiReply = response.text;
              break;
            }
          } catch (err) {
            process.stderr.write(`[WARN] Model execution failure: ${err.message}\n`);
          }
        }

        if (!aiReply) {
          aiReply = "🤖 Server load balancing issue. Try again shortly!";
        } else {
          // 4. Save the bot response and update records
          session.history.push({ role: 'model', parts: [{ text: aiReply }] });
          
          // Cap logs at last 14 turns to stay within optimal prompt limits
          if (session.history.length > 14) {
            session.history = session.history.slice(-14);
          }
          
          session.updatedAt = Date.now();
          await session.save();
        }

        await sendWhatsAppMessage(from, aiReply);

      } catch (dbErr) {
        process.stderr.write(`[CRITICAL ERROR]: ${dbErr.message}\n`);
      }
    }
  }
});
// Helper Function to send messages via WhatsApp API
async function sendWhatsAppMessage(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: text }
      },
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
  } catch (error) {
    throw new Error(JSON.stringify(error.response?.data || error.message));
  }
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));