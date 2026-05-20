import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import { connectDB, ChatSession } from './db.js';
import { MenuItem } from './MenuItem.js';


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


async function searchMenu(userQuery) {
  try {
    let items = [];
    const normalizedQuery = userQuery.toLowerCase();

    // 1. Check for specific food type filters if user mentions "veg" or "non-veg"
    let typeFilter = {};
    if (normalizedQuery.includes('non-veg') || normalizedQuery.includes('non veg')) {
      typeFilter = { foodType: 'Non-Veg' };
    } else if (normalizedQuery.includes('pure veg') || normalizedQuery.includes(' vegetarian') || normalizedQuery.includes(' veg')) {
      typeFilter = { foodType: 'Veg' };
    }

    // 2. Query execution combining text search and filters
    if (normalizedQuery.includes('menu') || normalizedQuery.includes('list') || normalizedQuery.includes('show items')) {
      // If they just ask for the general menu, fetch top available items grouped by category
      items = await MenuItem.find({ isAvailable: true, ...typeFilter }).limit(10);
    } else {
      // Keyword search (e.g., searching for "Paneer", "Noodles", "Sweet")
      items = await MenuItem.find(
        { $text: { $search: normalizedQuery }, ...typeFilter },
        { score: { $meta: "textScore" } }
      ).sort({ score: { $meta: "textScore" } }).limit(4);

      // Fallback regular expression matching if text score returns nothing
      if (items.length === 0) {
        items = await MenuItem.find({
          $and: [
            typeFilter,
            {
              $or: [
                { category: { $regex: normalizedQuery, $options: 'i' } },
                { keywords: { $in: [normalizedQuery] } }
              ]
            }
          ]
        }).limit(4);
      }
    }

    if (items.length === 0) {
      return "No matching menu items found at the moment.";
    }

    // 3. Format into structured layout for Gemini
    return items.map(item => {
      const indicator = item.foodType === 'Veg' ? '🟢 Veg' : '🔴 Non-Veg';
      const status = item.isAvailable ? 'In Stock' : 'OUT OF STOCK';
      return `Item: ${item.name} (${indicator})\nCategory: ${item.category}\nPrice: ₹${item.price}\nSpiciness: ${item.spicyLevel}\nPrep Time: ${item.prepTimeMinutes} mins\nStatus: ${status}\nDescription: ${item.description}\n---`;
    }).join('\n');

  } catch (error) {
    console.error("Menu fetch error:", error);
    return "Error checking the kitchen menu database.";
  }
}

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
        let session = await ChatSession.findOne({ whatsappNumber: from });
        if (!session) {
          session = new ChatSession({ whatsappNumber: from, history: [] });
        }

        session.history.push({ role: 'user', parts: [{ text: messageText }] });

        // Restaurant Intent Detection
        let menuContext = "";
        const restaurantKeywords = ['menu', 'food', 'order', 'dinner', 'lunch', 'eat', 'hungry', 'price', 'rate', 'veg', 'starters', 'main'];
        const hasRestaurantIntent = restaurantKeywords.some(kw => messageText.toLowerCase().includes(kw));

        if (hasRestaurantIntent) {
          process.stdout.write(`[RESTAURANT] Querying menu items for: "${messageText}"...\n`);
          menuContext = await searchMenu(messageText);
        }

        // Restaurant System Personality Rules
        const baseRestaurantInstruction = "You are 'ChefBot', the virtual host and ordering assistant for 'The Digital Bistro'. Your tone is warm, polite, and mouth-watering. Keep answers clean, conversational, and optimize descriptions for WhatsApp using simple *bold* text highlights for items and prices. Do not mention database IDs.";
        
        const dynamicInstruction = menuContext 
          ? `${baseRestaurantInstruction}\n\nLIVE KITCHEN MENU DATA:\nUse ONLY this data to state what is available and its price. Do not guess recipes or prices:\n${menuContext}\n\nCRITICAL INSTRUCTION: If an item state says 'Status: OUT OF STOCK', kindly inform the guest that the dish is sold out for today and suggest an alternative from the available items list.`
          : baseRestaurantInstruction;

        let aiReply = "";
        const modelsToTry = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-1.5-flash'];

        for (const modelName of modelsToTry) {
          try {
            const response = await ai.models.generateContent({
              model: modelName,
              contents: session.history, 
              config: { systemInstruction: dynamicInstruction }
            });

            if (response.text) {
              aiReply = response.text;
              break;
            }
          } catch (err) {
            process.stderr.write(`[WARN] Model drop on restaurant pipe: ${err.message}\n`);
          }
        }

        if (!aiReply) {
          aiReply = "🧑‍🍳 Our digital kitchen counter is experiencing a slight delay. Please send your message again!";
        } else {
          session.history.push({ role: 'model', parts: [{ text: aiReply }] });
          if (session.history.length > 14) session.history = session.history.slice(-14);
          session.updatedAt = Date.now();
          await session.save();
        }

        await sendWhatsAppMessage(from, aiReply);

      } catch (err) {
        process.stderr.write(`[RESTAURANT CRITICAL ERROR]: ${err.message}\n`);
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