/**
 * exportController — generates Excel/CSV reports.
 *
 * Routes:
 *   GET /api/export/leads              → all current leads as Excel
 *   GET /api/export/leads/archive      → archive leads to Excel then delete them
 *   GET /api/export/analytics          → Brevo event data as Excel
 */

import Lead    from '../models/Lead.js';
import XLSX    from 'xlsx';

// ---------------------------------------------------------------------------
// Helper: build Excel buffer from array of objects
// ---------------------------------------------------------------------------
function buildExcel(rows, sheetName = 'Sheet1') {
  const ws  = XLSX.utils.json_to_sheet(rows);
  const wb  = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// GET /api/export/leads?status=active&format=xlsx
// Export current leads as Excel (does NOT delete them)
// ---------------------------------------------------------------------------
export async function exportLeads(req, res) {
  const status = req.query.status || '';
  const format = req.query.format || 'xlsx';

  const filter = {};
  if (status && ['active','not_sent','bounced','unsubscribed'].includes(status)) {
    filter.status = status;
  }

  const leads = await Lead.find(filter).sort({ createdAt: -1 }).lean();

  if (leads.length === 0) {
    return res.status(404).json({ error: 'No leads found matching the filter.' });
  }

  const rows = leads.map((l) => ({
    Email:       l.email || '',
    Name:        l.name  || l.firstName || '',
    Company:     l.company   || '',
    Status:      l.status    || 'active',
    State:       l.state     || '',
    City:        l.city      || '',
    ImportBatch: l.importBatch || '',
    Imported:    l.createdAt ? new Date(l.createdAt).toLocaleDateString('en-IN') : '',
    LastBlastError: l.lastBlastError || '',
  }));

  const filename = `leads_${status || 'all'}_${today()}`;

  if (format === 'csv') {
    const csv = [
      Object.keys(rows[0]).join(','),
      ...rows.map((r) => Object.values(r).map((v) => `"${String(v).replace(/"/g,'""')}"`).join(',')),
    ].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
    return res.send(csv);
  }

  const buf = buildExcel(rows, 'Leads');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
  res.send(buf);
}

// ---------------------------------------------------------------------------
// GET /api/export/leads/archive?status=active
// Archives leads to Excel, then DELETES them from DB.
// Use for end-of-day cleanup — exports then wipes the list.
// ---------------------------------------------------------------------------
export async function archiveLeads(req, res) {
  const status = req.query.status || 'active';
  const filter = {};
  if (['active','not_sent','bounced','unsubscribed'].includes(status)) {
    filter.status = status;
  }

  const leads = await Lead.find(filter).sort({ createdAt: -1 }).lean();

  if (leads.length === 0) {
    return res.status(404).json({ error: `No ${status} leads to archive.` });
  }

  const rows = leads.map((l) => ({
    Email:       l.email     || '',
    Name:        l.name      || l.firstName || '',
    Company:     l.company   || '',
    Status:      l.status    || 'active',
    State:       l.state     || '',
    City:        l.city      || '',
    ImportBatch: l.importBatch || '',
    Imported:    l.createdAt ? new Date(l.createdAt).toLocaleDateString('en-IN') : '',
    LastBlastError: l.lastBlastError || '',
    ArchivedAt:  new Date().toLocaleDateString('en-IN'),
  }));

  // Delete from DB after building the Excel
  const ids = leads.map((l) => l._id);
  await Lead.deleteMany({ _id: { $in: ids } });

  const filename = `leads_archive_${status}_${today()}`;
  const buf = buildExcel(rows, 'Archived Leads');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
  res.send(buf);
}

// ---------------------------------------------------------------------------
// GET /api/export/analytics?company=launcherdesk&days=30
// Exports Brevo event data as Excel: who opened, clicked, bounced, etc.
// This is REAL data from Brevo's API — not mocked.
// ---------------------------------------------------------------------------
export async function exportAnalytics(req, res) {
  const company = req.query.company || 'launcherdesk';
  const days    = Math.min(90, parseInt(req.query.days) || 30);

  const COMPANY_KEYS = {
    launcherdesk:  [process.env.LD_BREVO_KEY_1, process.env.LD_BREVO_KEY_2, process.env.LD_BREVO_KEY_3],
    officerestore: [process.env.OR_BREVO_KEY_1, process.env.OR_BREVO_KEY_2],
  };

  const keys = (COMPANY_KEYS[company] || []).filter((k) => k && k.length > 10);
  if (keys.length === 0) return res.status(400).json({ error: 'No API keys configured.' });

  const end   = new Date();
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const fmt   = (d) => d.toISOString().slice(0, 10);

  const all = [];

  for (let i = 0; i < keys.length; i++) {
    let path = `/smtp/statistics/events?limit=500&startDate=${fmt(start)}&endDate=${fmt(end)}&sort=desc`;
    try {
      const res2 = await fetch(`https://api.brevo.com/v3${path}`, {
        headers: { 'api-key': keys[i] },
      });
      const body = await res2.json().catch(() => ({}));
      for (const e of body.events || []) {
        all.push({
          Date:      e.date ? new Date(e.date).toLocaleString('en-IN') : '',
          Recipient: e.email    || '',
          Event:     e.event    || '',
          Subject:   e.subject  || '',
          From:      e.from     || '',
          Reason:    e.reason   || '',
          Account:   `Account ${i + 1}`,
          MessageId: e.messageId || '',
        });
      }
    } catch (e) {
      console.error('[export] Brevo fetch error Account', i + 1, e.message);
    }
  }

  all.sort((a, b) => new Date(b.Date) - new Date(a.Date));

  if (all.length === 0) {
    return res.status(404).json({
      error: 'No events found. Brevo retains event data for ~30 days on free plans.',
    });
  }

  const filename = `email_analytics_${company}_${today()}`;
  const buf = buildExcel(all, 'Email Events');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
  res.send(buf);
}
