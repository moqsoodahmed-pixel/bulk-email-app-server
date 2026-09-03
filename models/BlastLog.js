import mongoose from 'mongoose';

/**
 * BlastLog — one document per campaign blast attempt.
 * Shared across all users: every admin can see every log entry.
 *
 * failedRecipients is cleared once a successful resend completes
 * (or the user manually dismisses them), keeping storage minimal.
 */
const blastLogSchema = new mongoose.Schema(
  {
    // Who triggered the blast
    triggeredBy: {
      userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
      userEmail: { type: String, required: true },
      userName:  { type: String, default: '' },
    },

    // Which campaign this log belongs to
    campaignId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', required: true },
    campaignName: { type: String, required: true },
    company:      { type: String, enum: ['launcherdesk', 'officerestore'], default: 'launcherdesk' },
    subject:      { type: String, default: '' },

    // Timing
    startedAt:   { type: Date, default: Date.now },
    completedAt: { type: Date },

    // Counts
    totalTargeted: { type: Number, default: 0 },
    totalSent:     { type: Number, default: 0 },
    totalFailed:   { type: Number, default: 0 },
    totalSkipped:  { type: Number, default: 0 },

    // Status of the blast itself
    blastStatus: {
      type:    String,
      enum:    ['running', 'completed', 'stopped', 'failed'],
      default: 'running',
      index:   true,
    },

    /**
     * Failed recipients — stored temporarily.
     * Cleared to [] once all are successfully resent or user dismisses them.
     * Each entry: { email, name, company, reason, retriedAt, retryStatus }
     */
    failedRecipients: [
      {
        email:       { type: String, required: true },
        name:        { type: String, default: '' },
        company:     { type: String, default: '' },
        reason:      { type: String, default: 'Unknown error' },
        retriedAt:   { type: Date },
        retryStatus: { type: String, enum: ['pending', 'success', 'failed'], default: 'pending' },
      },
    ],
  },
  { timestamps: true }
);

blastLogSchema.index({ createdAt: -1 });
blastLogSchema.index({ campaignId: 1 });

export default mongoose.model('BlastLog', blastLogSchema);
