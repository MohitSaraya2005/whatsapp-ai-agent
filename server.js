import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import { connectDB, ChatSession } from "./db.js";
import { MenuItem } from "./MenuItem.js";
import { Order } from "./Order.js";

connectDB().catch((err) => console.error("Database connection failure:", err));

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
    if (
      normalizedQuery.includes("non-veg") ||
      normalizedQuery.includes("non veg")
    ) {
      typeFilter = { foodType: "Non-Veg" };
    } else if (
      normalizedQuery.includes("pure veg") ||
      normalizedQuery.includes(" vegetarian") ||
      normalizedQuery.includes(" veg")
    ) {
      typeFilter = { foodType: "Veg" };
    }

    // 2. Query execution combining text search and filters
    if (
      normalizedQuery.includes("menu") ||
      normalizedQuery.includes("list") ||
      normalizedQuery.includes("show items")
    ) {
      // If they just ask for the general menu, fetch top available items grouped by category
      items = await MenuItem.find({ isAvailable: true, ...typeFilter }).limit(
        10,
      );
    } else {
      // Keyword search (e.g., searching for "Paneer", "Noodles", "Sweet")
      items = await MenuItem.find(
        { $text: { $search: normalizedQuery }, ...typeFilter },
        { score: { $meta: "textScore" } },
      )
        .sort({ score: { $meta: "textScore" } })
        .limit(4);

      // Fallback regular expression matching if text score returns nothing
      if (items.length === 0) {
        items = await MenuItem.find({
          $and: [
            typeFilter,
            {
              $or: [
                { category: { $regex: normalizedQuery, $options: "i" } },
                { keywords: { $in: [normalizedQuery] } },
              ],
            },
          ],
        }).limit(4);
      }
    }

    if (items.length === 0) {
      return "No matching menu items found at the moment.";
    }

    // 3. Format into structured layout for Gemini
    return items
      .map((item) => {
        const indicator = item.foodType === "Veg" ? "🟢 Veg" : "🔴 Non-Veg";
        const status = item.isAvailable ? "In Stock" : "OUT OF STOCK";
        return `Item: ${item.name} (${indicator})\nCategory: ${item.category}\nPrice: ₹${item.price}\nSpiciness: ${item.spicyLevel}\nPrep Time: ${item.prepTimeMinutes} mins\nStatus: ${status}\nDescription: ${item.description}\n---`;
      })
      .join("\n");
  } catch (error) {
    console.error("Menu fetch error:", error);
    return "Error checking the kitchen menu database.";
  }
}

// 1. Appends an item to the user's active database cart
async function handleAddToCart(whatsappNumber, itemText) {
  // Simple extraction regex looking for "qty x name" or just item names
  const menuItems = await MenuItem.find({ isAvailable: true });
  let matchedItem = menuItems.find((item) =>
    itemText.toLowerCase().includes(item.name.toLowerCase()),
  );

  if (!matchedItem)
    return "I couldn't find that item on our active menu card. Please check the spelling.";

  let cart = await Order.findOne({ whatsappNumber, status: "CART" });
  if (!cart) {
    cart = new Order({ whatsappNumber, items: [], totalAmount: 0 });
  }

  // Check if item is already in the cart to increment quantity
  const existingItemIndex = cart.items.findIndex(
    (i) => i.itemName === matchedItem.name,
  );
  if (existingItemIndex > -1) {
    cart.items[existingItemIndex].quantity += 1;
  } else {
    cart.items.push({
      itemName: matchedItem.name,
      quantity: 1,
      pricePerItem: matchedItem.price,
    });
  }

  // Recalculate total balance
  cart.totalAmount = cart.items.reduce(
    (sum, item) => sum + item.pricePerItem * item.quantity,
    0,
  );
  await cart.save();

  return `Added *${matchedItem.name}* (₹${matchedItem.price}) to your cart. Total: ₹${cart.totalAmount}.`;
}

// 2. Formats the user's current items into a crisp text manifest
async function getCartSummary(whatsappNumber) {
  const cart = await Order.findOne({ whatsappNumber, status: "CART" });
  if (!cart || cart.items.length === 0) return "Your current cart is empty.";

  const itemLines = cart.items
    .map(
      (i) => `• ${i.itemName} x${i.quantity} - ₹${i.pricePerItem * i.quantity}`,
    )
    .join("\n");
  return `Your Cart:\n${itemLines}\n\n*Total Amount: ₹${cart.totalAmount}*`;
}

// 1. Webhook Verification (GET)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === MO_VERIFY_TOKEN) {
    process.stdout.write("Webhook verified successfully!\n");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// 2. Handle Incoming Messages (POST)
app.post("/webhook", async (req, res) => {
  // Always acknowledge Meta immediately to prevent retry loops
  res.sendStatus(200);
  const body = req.body;

  if (
    body.object === "whatsapp_business_account" &&
    body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]
  ) {
    const messageObj = body.entry[0].changes[0].value.messages[0];
    const from = messageObj.from;
    const messageText = messageObj.text?.body?.trim();

    if (messageText) {
      try {
        // 1. Fetch or initialize the user's chat session with a default 'BROWSE' state
        let session = await ChatSession.findOne({ whatsappNumber: from });
        if (!session) {
          session = new ChatSession({
            whatsappNumber: from,
            currentState: "BROWSE",
            history: [],
          });
        }

        let interceptionReply = "";
        const lowercaseMsg = messageText.toLowerCase();
        // ==========================================
        // 1. STATE FLOW: CONFIRMING DELIVERY ADDRESS
        // ==========================================
        if (session.currentState === "CONFIRMING") {
          let cart = await Order.findOne({
            whatsappNumber: from,
            status: "CART",
          });
          if (cart) {
            cart.deliveryAddress = messageText;
            cart.status = "PLACED";
            await cart.save();

            session.currentState = "BROWSE";
            await session.save();

            interceptionReply = `🎉 *Order Confirmed!* Your order has been fired to our kitchen counter.\n\n🏠 *Delivery Address:* ${messageText}\n💳 *Total Bill:* ₹${cart.totalAmount}\n\nThank you for ordering from The Digital Bistro! 🧑‍🍳`;
            await sendWhatsAppMessage(from, interceptionReply);
            return; // Stop execution here
          }
        }

        // ==========================================
        // 2. INTERCEPT INTENT: CHECKOUT / FINAL BILL (MOVE THIS UP)
        // ==========================================
        if (
          lowercaseMsg === "checkout" ||
          lowercaseMsg.includes("place order") ||
          lowercaseMsg.includes("final bill") ||
          lowercaseMsg.includes("check out")
        ) {
          const summary = await getCartSummary(from);

          if (summary.includes("empty") || summary.includes("is empty")) {
            await sendWhatsAppMessage(
              from,
              "🛒 Your cart is currently empty! Type *'menu'* to explore our dishes first.",
            );
            return; // Stop execution here
          }

          // Lock down state machine to expect address entry next
          session.currentState = "CONFIRMING";
          await session.save();

          interceptionReply = `${summary}\n\nTo finalize your order, please reply directly back with your *complete home delivery address*.`;
          await sendWhatsAppMessage(from, interceptionReply);
          return; // Stop execution here
        }

        // ==========================================
        // 3. INTERCEPT INTENT: 'ADD TO CART'
        // ==========================================
        if (
          lowercaseMsg.startsWith("add ") ||
          lowercaseMsg.includes("order a") ||
          lowercaseMsg.includes("want to eat")
        ) {
          session.currentState = "ORDERING";

          interceptionReply = await handleAddToCart(from, messageText);

          session.history.push({
            role: "user",
            parts: [{ text: messageText }],
          });
          session.history.push({
            role: "model",
            parts: [{ text: interceptionReply }],
          });
          if (session.history.length > 14)
            session.history = session.history.slice(-14);

          session.updatedAt = Date.now();
          await session.save();

          await sendWhatsAppMessage(from, interceptionReply);
          return; // Stop execution here
        }

        // ==========================================
        // STATE FLOW 4: STANDARD AI MENU DISCOVERY
        // ==========================================
        session.history.push({ role: "user", parts: [{ text: messageText }] });

        // Restaurant Intent Search Detection
        let menuContext = "";
        const restaurantKeywords = [
          "menu",
          "food",
          "order",
          "dinner",
          "lunch",
          "eat",
          "hungry",
          "price",
          "rate",
          "veg",
          "starters",
          "main",
        ];
        const hasRestaurantIntent = restaurantKeywords.some((kw) =>
          lowercaseMsg.includes(kw),
        );

        if (hasRestaurantIntent) {
          process.stdout.write(
            `[RESTAURANT] Querying menu items for: "${messageText}"...\n`,
          );
          menuContext = await searchMenu(messageText);
        }

        // Get the active cart summary text stream to pass as direct context to Gemini
        let activeCartContext = await getCartSummary(from);

        // System instructions detailing persona and operational checkout formatting
        const baseRestaurantInstruction =
          "You are 'ChefBot', the virtual host and ordering assistant for 'The Digital Bistro'. Your tone is warm, polite, and mouth-watering. Keep answers clean, conversational, and optimize descriptions for WhatsApp using simple *bold* text highlights for items and prices. Do not mention database IDs.";

        const dynamicInstruction =
          `${baseRestaurantInstruction}\n\n` +
          `LIVE KITCHEN MENU DATA:\n${menuContext || "No specific items loaded."}\n\n` +
          `USER'S ACTIVE CART MANIFEST:\n${activeCartContext}\n\n` +
          `CRITICAL TRANSACTION RULE: If the guest expresses an explicit intent to order an item, politely instruct them to type exactly: "Add [Item Name]" so the database processing layer can record it successfully.`;

        let aiReply = "";
        const modelsToTry = [
          "gemini-2.5-flash",
          "gemini-2.5-flash-lite",
          "gemini-1.5-flash",
        ];

        for (const modelName of modelsToTry) {
          try {
            const response = await ai.models.generateContent({
              model: modelName,
              contents: session.history,
              config: { systemInstruction: dynamicInstruction },
            });

            if (response.text) {
              aiReply = response.text;
              break;
            }
          } catch (err) {
            process.stderr.write(
              `[WARN] Model drop on restaurant pipe: ${err.message}\n`,
            );
          }
        }

        if (!aiReply) {
          aiReply =
            "🧑‍🍳 Our digital kitchen counter is experiencing a slight delay. Please send your message again!";
        } else {
          session.history.push({ role: "model", parts: [{ text: aiReply }] });
          if (session.history.length > 14)
            session.history = session.history.slice(-14);
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
        messaging_product: "whatsapp",
        to: to,
        type: "text",
        text: { body: text },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      },
    );
  } catch (error) {
    throw new Error(JSON.stringify(error.response?.data || error.message));
  }
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
