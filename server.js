import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

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
// 2. Handle Incoming Messages (POST) with Auto-Retry & Fallback
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Always acknowledge Meta immediately

  const body = req.body;

  if (body.object === 'whatsapp_business_account' && body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
    const messageObj = body.entry[0].changes[0].value.messages[0];
    const from = messageObj.from; 
    const messageText = messageObj.text?.body; 

    if (messageText) {
      process.stdout.write(`\n[INCOMING] Message from ${from}: ${messageText}\n`);
      
      let aiReply = "";
      // List of models to try if the primary one is overloaded (503)
      const modelsToTry = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-1.5-flash'];

      // Attempt to get a response using model fallback and retry loops
      for (const modelName of modelsToTry) {
        let attempts = 0;
        const maxAttempts = 3;

        while (attempts < maxAttempts) {
          try {
            process.stdout.write(`[AI TRY] Attempting generation with ${modelName} (Try ${attempts + 1})...\n`);
            
            const response = await ai.models.generateContent({
              model: modelName,
              contents: messageText,
              config: {
                systemInstruction: "You are a helpful, concise AI assistant communicating over WhatsApp. Keep responses brief and conversational.",
              }
            });

            if (response.text) {
              aiReply = response.text;
              break; // Success! Break out of the retry loop
            }
          } catch (err) {
            attempts++;
            process.stderr.write(`[WARN] ${modelName} failed with: ${err.message}. \n`);
            
            if (attempts < maxAttempts) {
              // Wait 2 seconds before retrying this specific model
              await new Promise(resolve => setTimeout(resolve, 2000)); 
            }
          }
        }

        if (aiReply) break; // If a model succeeded, don't try the backup models
      }

      // If all models failed completely after all retries
      if (!aiReply) {
        aiReply = "🤖 Sorry, my brain is a bit overloaded with requests right now! Please try messaging me again in a minute.";
      }

      try {
        // Send whatever response we secured back to WhatsApp
        await sendWhatsAppMessage(from, aiReply);
        process.stdout.write(`[OUTGOING] Sent reply to ${from}\n`);
      } catch (deliveryErr) {
        process.stderr.write(`[ERROR] WhatsApp delivery failed: ${deliveryErr.message}\n`);
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