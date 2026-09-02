import Lead from '../models/Lead.js';
import Campaign from '../models/Campaign.js';

// ---------------------------------------------------------------------------
// Stop-signal map
// ---------------------------------------------------------------------------
const stopSignals = new Map();

// ---------------------------------------------------------------------------
// Company config — 2 Brevo keys for Launcherdesk, 1 for Officerestore
// ---------------------------------------------------------------------------
const COMPANY_CONFIG = {
  launcherdesk: {
    label:     'Launcherdesk',
    domain:    'launcherdesk.net',
    fromEmail: () => process.env.LAUNCHERDESK_FROM_EMAIL || 'sneha@launcherdesk.net',
    fromName:  () => process.env.LAUNCHERDESK_FROM_NAME  || 'Sneha',
    // 2 Brevo accounts = 600 emails/month
    apiKeys: () => [
      process.env.LD_BREVO_KEY_1,
      process.env.LD_BREVO_KEY_2,
    ].filter((k) => k && k.length > 10 && !k.includes('YOUR_')),
  },
  officerestore: {
    label:     'Officerestore',
    domain:    'officerestore.in',
    fromEmail: () => process.env.OFFICERESTORE_FROM_EMAIL || 'sneha@officerestore.in',
    fromName:  () => process.env.OFFICERESTORE_FROM_NAME  || 'Sneha',
    // 1 Brevo account = 300 emails/month
    apiKeys: () => [
      process.env.OR_BREVO_KEY_1,
    ].filter((k) => k && k.length > 10 && !k.includes('YOUR_')),
  },
};

function getCfg(key) {
  return COMPANY_CONFIG[key] || COMPANY_CONFIG.launcherdesk;
}

// ---------------------------------------------------------------------------
// Brevo account pool — rotates through keys when quota is hit
// ---------------------------------------------------------------------------
class BrevoPool {
  constructor(apiKeys) {
    this.accounts = apiKeys.map((key, i) => ({
      key, index: i + 1, remaining: 300, exhausted: false,
    }));
    this.current = 0;
  }

  get totalAccounts() { return this.accounts.length; }

  active() {
    while (this.current < this.accounts.length) {
      if (!this.accounts[this.current].exhausted) return this.accounts[this.current];
      this.current++;
    }
    return null; // all exhausted
  }

  markSent() {
    const acc = this.accounts[this.current];
    if (!acc) return;
    acc.remaining = Math.max(0, acc.remaining - 1);
    if (acc.remaining === 0) {
      acc.exhausted = true;
      this.current++;
      const next = this.active();
      if (next) console.log(`[pool] Account ${acc.index} quota done → switching to Account ${next.index}`);
      else       console.log('[pool] All accounts exhausted.');
    }
  }

  markExhausted() {
    const acc = this.accounts[this.current];
    if (!acc) return;
    console.log(`[pool] Account ${acc.index} quota hit — switching.`);
    acc.exhausted = true;
    acc.remaining = 0;
    this.current++;
  }

  summary() {
    return this.accounts.map((a) =>
      `Account ${a.index}: ${a.exhausted ? 'exhausted' : a.remaining + ' left'}`
    ).join(' | ');
  }
}

// ---------------------------------------------------------------------------
// Fetch live quota for a Brevo key
// ---------------------------------------------------------------------------
async function fetchQuota(apiKey) {
  try {
    const res  = await fetch('https://api.brevo.com/v3/account', {
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return null;
    const plan = (body.plan || []).find((p) => p.credits != null);
    if (plan) return { total: plan.credits, used: plan.creditsUsed || 0, remaining: plan.credits - (plan.creditsUsed || 0) };
    return null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------
function toText(raw) {
  return raw
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function personalise(tmpl, { name = '', company = '', email = '' }) {
  return tmpl
    .replace(/\{\{name\}\}/gi, name)
    .replace(/\{\{company\}\}/gi, company)
    .replace(/\{\{email\}\}/gi, email);
}

// ---------------------------------------------------------------------------
// Brevo API call
// ---------------------------------------------------------------------------
async function brevoReq(apiKey, path, method = 'GET', payload = null) {
  if (!apiKey) throw new Error('Brevo API key not set.');
  const opts = { method, headers: { 'Content-Type': 'application/json', 'api-key': apiKey } };
  if (payload) opts.body = JSON.stringify(payload);
  const res  = await fetch(`https://api.brevo.com/v3${path}`, opts);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, body };
}

async function sendViaBrevo({ to, toName, subject, htmlBody, fromEmail, fromName, replyTo, attachment, apiKey }) {
  // Convert plain-text (with \n) or HTML to both representations
  const isHtml = /<[a-z][\s\S]*>/i.test(htmlBody);
  const plain  = toText(htmlBody);

  // Build a clean HTML version from the plain text so line breaks render correctly
  const htmlSafe = plain
    .split('\n')
    .map((l) => l.trim() === '' ? '<br>' : `<span>${l.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</span>`)
    .join('<br>\n');

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:Arial,sans-serif;font-size:14px;line-height:1.8;color:#000;margin:0;padding:20px"><div style="max-width:600px;margin:0 auto">${isHtml ? htmlBody : htmlSafe}</div></body></html>`;

  const payload = {
    sender:      { name: fromName, email: fromEmail },
    to:          [{ email: to, name: toName || to }],
    subject,
    htmlContent: html,
    textContent: plain,
    ...(replyTo ? { replyTo: { email: replyTo, name: fromName } } : {}),
    // Required headers for cold-email deliverability
    headers: {
      'X-Mailin-custom': 'cold-outreach',
    },
    tags: ['cold-outreach'],
  };

  if (attachment && attachment.data && attachment.filename) {
    payload.attachment = [{ name: attachment.filename, content: attachment.data }];
  }

  const { ok, status, body } = await brevoReq(apiKey, '/smtp/email', 'POST', payload);
  if (!ok) {
    const detail = body.message || body.error || JSON.stringify(body);
    throw new Error(`Brevo ${status}: ${detail}`);
  }
  return body;
}

// ---------------------------------------------------------------------------
// Lead filter builder
// ---------------------------------------------------------------------------
function buildFilter(tf = {}) {
  const f = {};
  const s = tf.status || 'active';
  if (s !== 'all') f.status = s;
  if (tf.importBatch) f.importBatch = tf.importBatch;
  if (tf.state) {
    const arr = Array.isArray(tf.state) ? tf.state.filter(Boolean) : [tf.state].filter(Boolean);
    if (arr.length > 0) {
      f.state = { $in: arr.map((x) => new RegExp(`^${x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')) };
    }
  }
  if (tf.search) {
    const re = new RegExp(tf.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    f.$or = [{ email: re }, { name: re }, { company: re }];
  }
  return f;
}

// ---------------------------------------------------------------------------
// GET /api/campaigns/diagnose?company=launcherdesk
// Checks API keys + sender verification for a company
// ---------------------------------------------------------------------------
export async function diagnose(req, res) {
  const key = req.query.company || 'launcherdesk';
  const cfg = getCfg(key);
  const keys = cfg.apiKeys();
  const fromEmail = cfg.fromEmail();

  const results = [];

  for (let i = 0; i < keys.length; i++) {
    const apiKey = keys[i];
    const entry = { account: i + 1, apiKeyOk: false, senderVerified: false, quota: null, errors: [] };

    // 1. Check API key works
    try {
      const { ok, body, status } = await brevoReq(apiKey, '/account');
      if (!ok) {
        entry.errors.push(`API key invalid: ${status} — ${body.message || JSON.stringify(body)}`);
      } else {
        entry.apiKeyOk = true;
        const plan = (body.plan || []).find((p) => p.credits != null);
        if (plan) entry.quota = { total: plan.credits, used: plan.creditsUsed || 0, remaining: plan.credits - (plan.creditsUsed || 0) };
      }
    } catch (e) {
      entry.errors.push(`Account check failed: ${e.message}`);
    }

    // 2. Check sender is verified
    if (entry.apiKeyOk) {
      try {
        const { ok, body } = await brevoReq(apiKey, '/senders');
        if (ok) {
          const senders = body.senders || [];
          const match = senders.find((s) => s.email?.toLowerCase() === fromEmail.toLowerCase());
          if (!match) {
            entry.errors.push(`Sender "${fromEmail}" NOT found in Brevo. Add it at: Brevo → Senders & IPs → Senders → Add a New Sender`);
          } else if (!match.active) {
            entry.errors.push(`Sender "${fromEmail}" found but NOT active/verified yet. Check your inbox for Brevo's verification email.`);
          } else {
            entry.senderVerified = true;
          }
        }
      } catch (e) {
        entry.errors.push(`Sender check failed: ${e.message}`);
      }
    }

    results.push(entry);
  }

  const allOk = results.every((r) => r.apiKeyOk && r.senderVerified);
  res.json({
    company: key, label: cfg.label, fromEmail,
    allOk,
    accounts: results,
    summary: allOk
      ? '✅ All accounts OK — API keys valid and sender verified.'
      : '❌ Issues found — see each account\'s errors field.',
  });
}

// ---------------------------------------------------------------------------
// GET /api/campaigns/companies
// ---------------------------------------------------------------------------
export async function listCompanies(req, res) {
  const list = Object.entries(COMPANY_CONFIG).map(([key, cfg]) => ({
    key,
    label:        cfg.label,
    domain:       cfg.domain,
    fromEmail:    cfg.fromEmail(),
    fromName:     cfg.fromName(),
    accountCount: cfg.apiKeys().length,
    maxEmails:    cfg.apiKeys().length * 300,
  }));
  res.json({ companies: list });
}

// ---------------------------------------------------------------------------
// GET /api/campaigns/account-status?company=launcherdesk
// Returns live quota for each account
// ---------------------------------------------------------------------------
export async function accountStatus(req, res) {
  const key = req.query.company || 'launcherdesk';
  const cfg = getCfg(key);
  const keys = cfg.apiKeys();

  if (keys.length === 0) {
    return res.status(400).json({
      error: `No Brevo keys configured for ${cfg.label}. Add LD_BREVO_KEY_1/LD_BREVO_KEY_2 in .env`,
    });
  }

  const accounts = await Promise.all(
    keys.map(async (k, i) => ({
      index: i + 1,
      label: `Account ${i + 1}`,
      quota: await fetchQuota(k),
    }))
  );

  const totalRemaining = accounts.reduce((s, a) => s + (a.quota?.remaining || 0), 0);
  res.json({
    company:       key,
    label:         cfg.label,
    fromEmail:     cfg.fromEmail(),
    accounts,
    totalRemaining,
    totalCapacity: keys.length * 300,
  });
}

// ---------------------------------------------------------------------------
// GET /api/campaigns/brevo-status?company=launcherdesk
// ---------------------------------------------------------------------------
export async function brevoStatus(req, res) {
  const key  = req.query.company || 'launcherdesk';
  const cfg  = getCfg(key);
  const keys = cfg.apiKeys();
  if (keys.length === 0) return res.status(400).json({ error: `No Brevo keys for ${cfg.label}.` });

  try {
    const { ok, body, status } = await brevoReq(keys[0], '/account');
    if (!ok) return res.status(502).json({ error: body.message || `Brevo error ${status}` });

    const fromEmail  = cfg.fromEmail();
    const fromDomain = fromEmail.split('@')[1] || '';

    const { ok: sOk, body: sBody } = await brevoReq(keys[0], '/senders');
    const senders  = sOk ? (sBody.senders || []) : [];
    const verified = senders.some((s) => s.email?.toLowerCase() === fromEmail.toLowerCase() && s.active);

    const { ok: dOk, body: dBody } = await brevoReq(keys[0], '/senders/domains');
    const domains    = dOk ? (dBody.domains || []) : [];
    const domainInfo = domains.find((d) => d.domainName === fromDomain) || null;

    res.json({
      company: key, label: cfg.label, fromEmail, fromDomain,
      senderVerified: verified, domainInfo,
      accountCount:  keys.length,
      totalCapacity: keys.length * 300,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ---------------------------------------------------------------------------
// GET /api/campaigns/states
// ---------------------------------------------------------------------------
export async function listStates(req, res) {
  const results = await Lead.aggregate([
    { $match: { state: { $ne: '' }, status: 'active' } },
    { $group: { _id: '$state', count: { $sum: 1 } } },
    { $match: { _id: { $ne: null } } },
    { $sort: { count: -1 } },
    { $project: { _id: 0, state: '$_id', count: 1 } },
  ]);
  const unclassified = await Lead.countDocuments({ state: '', status: 'active' });
  res.json({ states: results, unclassified, total: results.reduce((s, r) => s + r.count, 0) + unclassified });
}

// ---------------------------------------------------------------------------
// GET /api/campaigns/blasted-states?importBatch=xxx&company=xxx
// ---------------------------------------------------------------------------
export async function blastedStates(req, res) {
  const { importBatch, company } = req.query;
  if (!importBatch) return res.json({ blastedStates: [], manualStates: [], allBlasted: false });

  const done = await Campaign.find({
    'targetFilter.importBatch': importBatch,
    company:                   company || 'launcherdesk',
    status:                    { $in: ['sent', 'stopped'] },
  }).select('targetFilter.state stats name').lean();

  const blasted = new Set();
  const manual  = new Set();

  for (const c of done) {
    const states   = c.targetFilter?.state || [];
    const isManual = (c.name || '').startsWith('[Manual]');
    if (states.length === 0 && c.stats?.sent > 0) {
      return res.json({ blastedStates: [], manualStates: [], allBlasted: true });
    }
    states.forEach((s) => { blasted.add(s); if (isManual) manual.add(s); });
  }

  res.json({ blastedStates: [...blasted], manualStates: [...manual], allBlasted: false });
}

// ---------------------------------------------------------------------------
// POST /api/campaigns/manual-blast
// ---------------------------------------------------------------------------
export async function manualMarkBlasted(req, res) {
  const { importBatch, company: co = 'launcherdesk', state } = req.body;
  if (!importBatch) return res.status(400).json({ error: 'importBatch is required.' });
  if (!state)       return res.status(400).json({ error: 'state is required.' });

  const exists = await Campaign.findOne({
    'targetFilter.importBatch': importBatch,
    'targetFilter.state': state, company: co, status: 'sent',
    name: { $regex: /^\[Manual\]/ },
  });
  if (exists) return res.status(409).json({ error: `${state} already marked.` });

  const c = await Campaign.create({
    name: `[Manual] ${state} — ${new Date().toLocaleDateString('en-IN')}`,
    subject: 'Manual mark', body: 'Manually marked as sent.',
    company: co,
    targetFilter: { status: 'active', search: '', importBatch, state: [state] },
    provider: 'brevo', stats: { total: 0, sent: 0, failed: 0 },
    status: 'sent', sentAt: new Date(),
  });
  res.status(201).json({ message: `${state} marked as sent.`, campaign: c });
}

// ---------------------------------------------------------------------------
// DELETE /api/campaigns/manual-blast
// ---------------------------------------------------------------------------
export async function manualUnmarkBlasted(req, res) {
  const { importBatch, company: co = 'launcherdesk', state } = req.body;
  if (!importBatch) return res.status(400).json({ error: 'importBatch is required.' });
  if (!state)       return res.status(400).json({ error: 'state is required.' });

  const r = await Campaign.deleteOne({
    'targetFilter.importBatch': importBatch,
    'targetFilter.state': state, company: co, status: 'sent',
    name: { $regex: /^\[Manual\]/ },
  });
  if (r.deletedCount === 0) return res.status(404).json({ error: `No manual mark found for ${state}.` });
  res.json({ message: `${state} unmarked.` });
}

// ---------------------------------------------------------------------------
// GET /api/campaigns/preview-count
// ---------------------------------------------------------------------------
export async function previewCount(req, res) {
  const { status = 'active', search = '', importBatch = '' } = req.query;
  const stateArr = req.query.state ? req.query.state.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const filter   = buildFilter({ status, search, importBatch, state: stateArr.length ? stateArr : undefined });
  const count    = await Lead.countDocuments(filter);
  const batches  = await Lead.distinct('importBatch').then((a) => a.filter(Boolean).sort().reverse());
  res.json({ count, batches });
}

// ---------------------------------------------------------------------------
// POST /api/campaigns/test
// ---------------------------------------------------------------------------
export async function testSend(req, res) {
  const { subject, body, fromName, testEmail, company: co = 'launcherdesk' } = req.body;
  if (!subject || !body)   return res.status(400).json({ error: 'subject and body are required.' });
  if (!testEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(testEmail))
    return res.status(400).json({ error: 'Valid testEmail required.' });

  const cfg  = getCfg(co);
  const keys = cfg.apiKeys();
  if (keys.length === 0)
    return res.status(500).json({ error: `No Brevo keys for ${cfg.label}. Add LD_BREVO_KEY_1 etc in .env.` });

  const fromEmail  = cfg.fromEmail();
  const senderName = fromName || cfg.fromName();
  const htmlBody   = personalise(body,    { name: 'Test User', company: 'Example Company', email: testEmail });
  const subj       = personalise(subject, { name: 'Test User', company: 'Example Company', email: testEmail });

  let attachment = null;
  if (req.file) attachment = { filename: req.file.originalname, mimeType: req.file.mimetype, data: req.file.buffer.toString('base64') };

  try {
    const r = await sendViaBrevo({ to: testEmail, toName: 'Test User', subject: subj, htmlBody, fromEmail, fromName: senderName, replyTo: fromEmail, attachment, apiKey: keys[0] });
    console.log(`[testSend] OK — messageId: ${r?.messageId || 'n/a'}, from: ${fromEmail}, to: ${testEmail}`);
    res.json({
      message:   `Sent from ${fromEmail} (Account 1 of ${keys.length}) to ${testEmail}.`,
      messageId: r && r.messageId ? r.messageId : null,
      tips: [
        'Check Primary inbox first.',
        'Check Promotions tab second.',
        'Gmail search: from:' + fromEmail,
        'Check Spam — click "Report as not spam" if found there.',
        'Allow up to 2 minutes.',
      ],
    });
  } catch (err) {
    // Log full Brevo error for debugging
    console.error('[testSend] FAILED —', err.message);
    res.status(502).json({
      error: err.message,
      hint: err.message.includes('sender')
        ? `Sender "${fromEmail}" may not be verified in Brevo. Go to Brevo → Senders & IPs → Senders and verify this email address.`
        : err.message.includes('401') || err.message.includes('403')
        ? 'Brevo API key is invalid or expired. Check LD_BREVO_KEY_1 in your server .env.'
        : undefined,
    });
  }
}

// ---------------------------------------------------------------------------
// GET /api/campaigns
// ---------------------------------------------------------------------------
export async function listCampaigns(req, res) {
  const page  = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 20;
  const skip  = (page - 1) * limit;
  const cf    = req.query.company ? { company: req.query.company } : {};
  const [campaigns, total] = await Promise.all([
    Campaign.find(cf).select('-attachment.data').sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Campaign.countDocuments(cf),
  ]);
  res.json({ campaigns, pagination: { page, total, pages: Math.ceil(total / limit) } });
}

// ---------------------------------------------------------------------------
// POST /api/campaigns
// ---------------------------------------------------------------------------
export async function createAndSendCampaign(req, res) {
  const { name, subject, body, fromName, company: co = 'launcherdesk' } = req.body;
  let tf = {};
  try { if (req.body.targetFilter) tf = JSON.parse(req.body.targetFilter); } catch { /**/ }

  if (!name || !subject || !body) return res.status(400).json({ error: 'name, subject, body required.' });

  const cfg  = getCfg(co);
  const keys = cfg.apiKeys();
  if (keys.length === 0)
    return res.status(500).json({ error: `No Brevo keys for ${cfg.label}. Add LD_BREVO_KEY_1 etc in .env.` });

  const filter = buildFilter(tf);
  const total  = await Lead.countDocuments(filter);
  if (total === 0) return res.status(400).json({ error: 'No leads match the selected filter.' });

  let attachment = { filename: '', mimeType: '', data: '' };
  if (req.file) attachment = { filename: req.file.originalname, mimeType: req.file.mimetype, data: req.file.buffer.toString('base64') };

  const campaign = await Campaign.create({
    name, subject, body,
    fromName:     fromName || cfg.fromName(),
    company:      co,
    targetFilter: { status: tf.status || 'active', search: tf.search || '', importBatch: tf.importBatch || '', state: Array.isArray(tf.state) ? tf.state : [] },
    provider:     'brevo',
    attachment,
    stats:        { total, sent: 0, failed: 0 },
    status:       'sending',
    createdBy:    req.user?._id || null,
  });

  res.status(201).json({
    campaign,
    message: `Campaign started. Sending ${total} emails via ${keys.length} Brevo account${keys.length > 1 ? 's' : ''} (capacity: ${keys.length * 300})…`,
  });

  sendEmails(campaign, filter, cfg, keys).catch((err) => console.error('[campaign] bg error:', err));
}

// ---------------------------------------------------------------------------
// Background sender — rotates accounts automatically
// ---------------------------------------------------------------------------
async function sendEmails(campaign, filter, cfg, apiKeys) {
  const fromEmail  = cfg.fromEmail();
  const fromName   = campaign.fromName || cfg.fromName();
  const attachment = campaign.attachment?.data && campaign.attachment?.filename ? campaign.attachment : null;

  const pool = new BrevoPool(apiKeys);
  console.log(`[campaign] "${campaign.name}" — ${pool.totalAccounts} account(s), capacity ${pool.totalAccounts * 300}`);

  let sent = 0, failed = 0;
  const BATCH = 50;
  let skip = 0;
  const id = campaign._id.toString();
  stopSignals.set(id, false);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (stopSignals.get(id)) { console.log(`[campaign] Stopped after ${sent} sent.`); break; }

    const acc = pool.active();
    if (!acc) {
      console.log('[campaign] All accounts exhausted.');
      await Campaign.findByIdAndUpdate(campaign._id, {
        'stats.lastError': `All ${pool.totalAccounts} Brevo account${pool.totalAccounts > 1 ? 's' : ''} have reached their monthly quota (${pool.totalAccounts * 300} emails). Wait for next month or add more accounts.`,
      });
      break;
    }

    const leads = await Lead.find(filter).select('email name firstName company').skip(skip).limit(BATCH).lean();
    if (leads.length === 0) break;
    skip += leads.length;

    for (const lead of leads) {
      if (stopSignals.get(id)) break;

      const activeAcc = pool.active();
      if (!activeAcc) break;

      if (!lead.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) {
        failed++;
        console.warn(`[campaign] Skipped invalid email: "${lead.email}"`);
        continue;
      }

      try {
        const pName   = lead.name || lead.firstName || lead.email.split('@')[0];
        const company = lead.company || '';
        const html    = personalise(campaign.body,    { name: pName, company, email: lead.email });
        const subj    = personalise(campaign.subject, { name: pName, company, email: lead.email });

        await sendViaBrevo({ to: lead.email, toName: pName, subject: subj, htmlBody: html, fromEmail, fromName, replyTo: fromEmail, attachment, apiKey: activeAcc.key });

        sent++;
        pool.markSent();

        if (sent % 10 === 0) {
          await Campaign.findByIdAndUpdate(campaign._id, {
            'stats.sent':      sent,
            'stats.failed':    failed,
            'stats.lastError': pool.summary(),
          });
        }
        await sleep(1500);
      } catch (err) {
        failed++;
        const reason = err.message || 'Unknown';
        console.error(`[campaign] Failed → ${lead.email} (Acc ${activeAcc.index}): ${reason}`);
        // Log hint for common Brevo sender-not-verified error
        if (reason.includes('sender') || reason.includes('Sender')) {
          console.error('[campaign] HINT: Verify sender email in Brevo → Senders & IPs → Senders');
        }

        if (reason.includes('429') || /quota|daily.limit|plan.limit/i.test(reason)) {
          pool.markExhausted();
          if (!pool.active()) break;
        } else if (failed === 1) {
          await Campaign.findByIdAndUpdate(campaign._id, { 'stats.lastError': reason });
        }
      }
    }
  }

  const stopped = stopSignals.get(id) === true;
  stopSignals.delete(id);

  await Campaign.findByIdAndUpdate(campaign._id, {
    status:         stopped ? 'stopped' : (sent === 0 ? 'failed' : 'sent'),
    sentAt:         new Date(),
    'stats.sent':   sent,
    'stats.failed': failed,
  });
  console.log(`[campaign] "${campaign.name}" ${stopped ? 'STOPPED' : 'DONE'} — ${pool.summary()}`);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// POST /api/campaigns/:id/stop
// ---------------------------------------------------------------------------
export async function stopCampaign(req, res) {
  const c = await Campaign.findById(req.params.id);
  if (!c) return res.status(404).json({ error: 'Campaign not found.' });
  if (c.status !== 'sending') return res.status(409).json({ error: `Not sending (status: ${c.status}).` });
  stopSignals.set(req.params.id, true);
  await Campaign.findByIdAndUpdate(req.params.id, { status: 'stopped' });
  res.json({ message: 'Stop signal sent.' });
}

// ---------------------------------------------------------------------------
// GET /api/campaigns/:id
// ---------------------------------------------------------------------------
export async function getCampaign(req, res) {
  const c = await Campaign.findById(req.params.id).select('-attachment.data').lean();
  if (!c) return res.status(404).json({ error: 'Campaign not found.' });
  res.json({ campaign: c });
}

// ---------------------------------------------------------------------------
// DELETE /api/campaigns/:id
// ---------------------------------------------------------------------------
export async function deleteCampaign(req, res) {
  const c = await Campaign.findById(req.params.id);
  if (!c) return res.status(404).json({ error: 'Campaign not found.' });
  if (c.status === 'sending') return res.status(409).json({ error: 'Cannot delete a sending campaign.' });
  await c.deleteOne();
  res.json({ message: 'Campaign deleted.' });
}