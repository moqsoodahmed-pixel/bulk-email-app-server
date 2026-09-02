import mongoose from 'mongoose';

const leadSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    // Normalised email for fuzzy-duplicate detection (dots/alias stripped).
    // e.g. john.doe+promo@gmail.com → johndoe@gmail.com
    canonical: {
      type: String,
      lowercase: true,
      trim: true,
      index: true,
    },
    name: { type: String, trim: true, default: '' },
    firstName: { type: String, trim: true, default: '' },
    lastName: { type: String, trim: true, default: '' },
    company: { type: String, trim: true, default: '' },
    phone: { type: String, trim: true, default: '' },
    state: { type: String, trim: true, default: '', index: true },
    city:  { type: String, trim: true, default: '' },
    tags: { type: [String], default: [] },
    status: {
      type: String,
      enum: ['active', 'unsubscribed', 'bounced'],
      default: 'active',
      index: true,
    },
    importBatch: { type: String, default: '' },
    lastContactedAt: { type: Date },
  },
  { timestamps: true }
);

leadSchema.index({ email: 'text', name: 'text', company: 'text' });

export default mongoose.model('Lead', leadSchema);