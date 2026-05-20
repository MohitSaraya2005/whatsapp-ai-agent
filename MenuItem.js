import mongoose from 'mongoose';

const MenuItemSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  description: { type: String, required: true },
  price: { type: Number, required: true },
  category: { type: String, required: true }, // e.g., "Starters", "Main Course", "Desserts", "Beverages"
  isAvailable: { type: Boolean, default: true }, // Kitchen stock status
  foodType: { type: String, enum: ['Veg', 'Non-Veg', 'Egg'], required: true },
  spicyLevel: { type: String, enum: ['Mild', 'Medium', 'Spicy', 'Extra Spicy'], default: 'Medium' },
  prepTimeMinutes: { type: Number, default: 15 }, // Estimated preparation time
  keywords: [{ type: String }] // e.g., ["paneer", "spicy", "cheese", "chinese"]
});

// Create text index for quick natural language item search
MenuItemSchema.index({ name: 'text', description: 'text', category: 'text', keywords: 'text' });

export const MenuItem = mongoose.model('MenuItem', MenuItemSchema);