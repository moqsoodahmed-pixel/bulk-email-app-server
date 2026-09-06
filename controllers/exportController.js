/**
 * exportController — generates CSV reports that open natively in Excel.
 * No external packages needed — pure Node.js string building.
 *
 * Routes:
 *   GET /api/export/leads              → all leads as CSV
 *   GET /api/export/leads/archive      → export leads to CSV then delete them
 *   GET /api/export/analytics          → Brevo event data as CSV
 */

import Lead from '../models/Lead.js';

// ---------------------------------------------------------------------------
// Helper: safely escape a CSV cell value
// ---------------------------------------------------------------------------
function csvCell(val) {
  const s = String(val ?? '').replace(/"/g, '""');
  return `"${s}"`;
}

function buildCSV(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const lines   = [
    headers.map(csvCell).join(','),
    ...rows.map((r) => headers.map((h) => csvCell(r[h])).join(',')),
  ];
  return lines.join('\r\n');
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function sendCSV(res, csv, filename) {
  // UTF-8 BOM so Excel opens with correct encoding
  const bom = '\uFEFF';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
  res.send(bom + csv);
}

// ---------------------------------------------------------------------------
// GET /api/export/leads?status=all
// Export current leads as CSV (does NOT delete them)
// ---------------------------------------------------------------------------
export async function exportLeads(req, res) {
  const status = req.query.status || '';

  const filter = {};
  if (status && ['active','not_sent','bounced','unsubscribed'].includes(status)) {
    filter.status = status;
  }

  const leads = await Lead.find(filter).sort({ createdAt: -1 }).lean();

  if (!leads.length) {
    return res.status(404).json({ error: 'No leads found.' });
  }

  const rows = leads.map((l) => ({
    Email:          l.email     || '',
    Name:           l.name      || l.firstName || '',
    Company:        l.company   || '',
    Status:         l.status    || 'active',
    State:          l.state     || '',
    City:           l.city      || '',
    'Import Batch': l.importBatch || '',
    Imported:       l.createdAt ? new Date(l.createdAt).toLocaleDateString('en-IN') : '',
    'Blast Error':  l.lastBlastError || '',
  }));

  sendCSV(res, buildCSV(rows), `leads_${status || 'all'}_${today()}`);
}

// ---------------------------------------------------------------------------
// GET /api/export/leads/archive?status=active
// Export leads to CSV then DELETE them from DB.
// ---------------------------------------------------------------------------
export async function archiveLeads(req, res) {
  const status = req.query.status || 'active';
  const filter = ['active','not_sent','bounced','unsubscribed'].includes(status)
    ? { status }
    : {};

  const leads = await Lead.find(filter).sort({ createdAt: -1 }).lean();

  if (!leads.length) {
    return res.status(404).json({ error: `No ${status} leads to archive.` });
  }

  const rows = leads.map((l) => ({
    Email:          l.email     || '',
    Name:           l.name      || l.firstName || '',
    Company:        l.company   || '',
    Status:         l.status    || 'active',
    State:          l.state     || '',
    City:           l.city      || '',
    'Import Batch': l.importBatch || '',
    Imported:       l.createdAt ? new Date(l.createdAt).toLocaleDateString('en-IN') : '',
    'Blast Error':  l.lastBlastError || '',
    'Archived At':  new Date().toLocaleDateString('en-IN'),
  }));

  const csv      = buildCSV(rows);
  const filename = `leads_archive_${status}_${today()}`;
  const ids      = leads.map((l) => l._id);

  // Delete AFTER building CSV so data is safe
  await Lead.deleteMany({ _id: { $in: ids } });

  sendCSV(res, csv, filename);
}

// ---------------------------------------------------------------------------
// GET /api/export/analytics?company=launcherdesk&days=30
// Brevo SMTP event data as CSV — real data, not mocked.
// ---------------------------------------------------------------------------
export async function exportAnalytics(req, res) {
  const company = req.query.company || 'launcherdesk';
  const days    = Math.min(90, parseInt(req.query.days) || 30);

  const KEY_MAP = {
    launcherdesk:  [process.env.LD_BREVO_KEY_1, process.env.LD_BREVO_KEY_2, process.env.LD_BREVO_KEY_3],
    officerestore: [process.env.OR_BREVO_KEY_1, process.env.OR_BREVO_KEY_2],
  };

  const keys = (KEY_MAP[company] || []).filter((k) => k && k.length > 10);
  if (!keys.length) return res.status(400).json({ error: 'No API keys configured.' });

  const end   = new Date();
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const fmt   = (d) => d.toISOString().slice(0, 10);

  const all = [];

  for (let i = 0; i < keys.length; i++) {
    const path = `/smtp/statistics/events?limit=500&startDate=${fmt(start)}&endDate=${fmt(end)}&sort=desc`;
    try {
      const r    = await fetch(`https://api.brevo.com/v3${path}`, {
        headers: { 'api-key': keys[i] },
      });
      const body = await r.json().catch(() => ({}));
      for (const e of body.events || []) {
        all.push({
          Date:       e.date ? new Date(e.date).toLocaleString('en-IN') : '',
          Recipient:  e.email     || '',
          Event:      e.event     || '',
          Subject:    e.subject   || '',
          From:       e.from      || '',
          Reason:     e.reason    || '',
          Account:    `Account ${i + 1}`,
          'Message ID': e.messageId || '',
        });
      }
    } catch (e) {
      console.error('[export] Brevo Account', i + 1, e.message);
    }
  }

  all.sort((a, b) => new Date(b.Date) - new Date(a.Date));

  if (!all.length) {
    return res.status(404).json({
      error: 'No events found. Brevo keeps event data for ~30 days on free plans.',
    });
  }

  sendCSV(res, buildCSV(all), `email_analytics_${company}_${today()}`);
}