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
app.post('/webhook', async (req, res) => {
  // Acknowledge receipt to Meta instantly
  res.sendStatus(200);

  const body = req.body;

  if (body.object === 'whatsapp_business_account' && body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
    const messageObj = body.entry[0].changes[0].value.messages[0];
    const from = messageObj.from; 
    const messageText = messageObj.text?.body; 

    if (messageText) {
      process.stdout.write(`\n[INCOMING] Message from ${from}: ${messageText}\n`);
      
      try {
        // Generate a response using Gemini
        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: messageText,
          config: {
            // Give your agent an identity/role
            systemInstruction: "You are a helpful, concise AI assistant communicating over WhatsApp. Keep responses brief, conversational, and avoid heavy markdown formatting like bold headers, since WhatsApp formatting is limited.",
          }
        });

        const aiReply = response.text || "Sorry, I couldn't process that request.";
        process.stdout.write(`[AI RESPONSE] Generated: ${aiReply}\n`);

        // Send the AI response back to WhatsApp
        await sendWhatsAppMessage(from, aiReply);
        process.stdout.write(`[OUTGOING] Sent reply to ${from}\n`);

      } catch (err) {
        process.stderr.write(`[ERROR] AI or WhatsApp delivery failed: ${err.message}\n`);
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