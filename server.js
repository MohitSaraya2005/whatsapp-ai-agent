import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MO_VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// 1. Webhook Verification (GET)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === MO_VERIFY_TOKEN) {
    console.log('Webhook verified successfully!');
    return res.status(200).send(challenge);
  }
  
  return res.sendStatus(403);
});

// 2. Handle Incoming Messages (POST)
app.post('/webhook', async (req, res) => {
  // Acknowledge receipt to Meta immediately to prevent retry loops
  res.sendStatus(200);

  const body = req.body;

  // Check if it's a valid WhatsApp message event
  if (body.object === 'whatsapp_business_account' && body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
    const messageObj = body.entry[0].changes[0].value.messages[0];
    const from = messageObj.from; // Customer's phone number
    const messageText = messageObj.text?.body; // The actual message text

    if (messageText) {
      console.log(`Received message from ${from}: ${messageText}`);
      
      // TODO: Pass 'messageText' to your AI layer (Gemini/Groq) to get a response string
      const aiReply = `You said: "${messageText}". (AI logic goes here!)`;

      await sendWhatsAppMessage(from, aiReply);
    }
  }
});

// Helper Function to send messages back via WhatsApp API
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
    console.log(`Message sent to ${to}`);
  } catch (error) {
    console.error('Error sending WhatsApp message:', error.response?.data || error.message);
  }
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));