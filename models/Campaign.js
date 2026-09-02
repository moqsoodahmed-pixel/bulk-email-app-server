import mongoose from 'mongoose';

const campaignSchema = new mongoose.Schema(
  {
    name:    { type: String, required: true, trim: true },
    subject: { type: String, required: true, trim: true },
    body:    { type: String, required: true },
    fromName:{ type: String, trim: true, default: '' },

    provider: { type: String, enum: ['ses', 'brevo'], default: 'brevo' },

    attachment: {
      filename: { type: String, default: '' },
      mimeType: { type: String, default: '' },
      data:     { type: String, default: '' },
    },

    targetFilter: {
      status:      { type: String, default: 'active' },
      search:      { type: String, default: '' },
      importBatch: { type: String, default: '' },
      state:       { type: [String], default: [] },
    },

    company: {
      type:    String,
      enum:    ['launcherdesk', 'officerestore'],
      default: 'launcherdesk',
      index:   true,
    },

    stats: {
      total:     { type: Number, default: 0 },
      sent:      { type: Number, default: 0 },
      failed:    { type: Number, default: 0 },
      lastError: { type: String, default: '' },
    },

    status: {
      type:    String,
      enum:    ['draft', 'sending', 'sent', 'failed', 'stopped'],
      default: 'draft',
      index:   true,
    },

    sentAt:    { type: Date },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

export default mongoose.model('Campaign', campaignSchema);