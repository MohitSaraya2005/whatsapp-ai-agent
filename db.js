import mongoose from 'mongoose';

const ChatSessionSchema = new mongoose.Schema({
  whatsappNumber: { type: String, required: true, unique: true },
  currentState: { type: String, enum: ['BROWSE', 'ORDERING', 'CONFIRMING'], default: 'BROWSE' },
  history: [
    {
      role: { type: String, enum: ['user', 'model'], required: true },
      parts: [{ text: { type: String, required: true } }]
    }
  ],
  updatedAt: { type: Date, default: Date.now }
});

export const ChatSession = mongoose.model('ChatSession', ChatSessionSchema);

export async function connectDB() {
  if (mongoose.connection.readyState >= 1) return;
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to MongoDB Atlas successfully.");
}