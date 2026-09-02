import mongoose from 'mongoose';

export async function connectDB() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI not set in environment');

  mongoose.set('strictQuery', true);

  await mongoose.connect(uri);
  console.log('[db] MongoDB connected');

  mongoose.connection.on('error', (err) => {
    console.error('[db] MongoDB connection error:', err);
  });
  mongoose.connection.on('disconnected', () => {
    console.warn('[db] MongoDB disconnected');
  });
}
