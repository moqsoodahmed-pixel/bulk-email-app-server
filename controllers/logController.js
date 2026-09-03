import BlastLog from '../models/BlastLog.js';
import Campaign  from '../models/Campaign.js';

// ---------------------------------------------------------------------------
// GET /api/logs
// Returns all blast logs, newest first — shared across all admins.
// ---------------------------------------------------------------------------
export async function listLogs(req, res) {
  const page  = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 30;
  const skip  = (page - 1) * limit;

  const [logs, total] = await Promise.all([
    BlastLog.find()
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    BlastLog.countDocuments(),
  ]);

  res.json({ logs, pagination: { page, total, pages: Math.ceil(total / limit) } });
}

// ---------------------------------------------------------------------------
// GET /api/logs/:id
// ---------------------------------------------------------------------------
export async function getLog(req, res) {
  const log = await BlastLog.findById(req.params.id).lean();
  if (!log) return res.status(404).json({ error: 'Log not found.' });
  res.json({ log });
}

// ---------------------------------------------------------------------------
// POST /api/logs/:id/resend
// Resends all pending failed recipients in this log entry.
// On full success, clears failedRecipients from the log (no permanent storage).
// ---------------------------------------------------------------------------
export async function resendFailed(req, res) {
  const log = await BlastLog.findById(req.params.id);
  if (!log) return res.status(404).json({ error: 'Log not found.' });

  const pending = log.failedRecipients.filter((r) => r.retryStatus === 'pending');
  if (pending.length === 0) {
    return res.status(400).json({ error: 'No pending failed recipients to resend.' });
  }

  // Get the original campaign for subject/body/config
  const campaign = await Campaign.findById(log.campaignId).lean();
  if (!campaign) return res.status(404).json({ error: 'Original campaign not found.' });

  // We import dynamically to avoid circular deps — the sendViaBrevo + helpers
  // are not exported from campaignController so we call the resend via a small
  // inline Brevo call using the same env keys.
  const { resendViaCampaign } = await import('./campaignController.js');

  res.json({ message: `Resend started for ${pending.length} failed recipient(s).` });

  // Run in background
  resendViaCampaign(log, campaign, pending).catch((e) =>
    console.error('[resend] bg error:', e.message)
  );
}

// ---------------------------------------------------------------------------
// DELETE /api/logs/:id/failed
// Dismiss (clear) all failed recipients from a log without resending.
// ---------------------------------------------------------------------------
export async function clearFailed(req, res) {
  const log = await BlastLog.findById(req.params.id);
  if (!log) return res.status(404).json({ error: 'Log not found.' });
  log.failedRecipients = [];
  await log.save();
  res.json({ message: 'Failed recipients cleared.' });
}
