import mongoose from 'mongoose';

const OrderSchema = new mongoose.Schema({
  whatsappNumber: { type: String, required: true },
  items: [
    {
      itemName: { type: String, required: true },
      quantity: { type: Number, required: true, default: 1 },
      pricePerItem: { type: Number, required: true }
    }
  ],
  totalAmount: { type: Number, required: true, default: 0 },
  status: { 
    type: String, 
    enum: ['CART', 'PLACED', 'PREPARING', 'COMPLETED', 'CANCELLED'], 
    default: 'CART' 
  },
  deliveryAddress: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now }
});

export const Order = mongoose.model('Order', OrderSchema);