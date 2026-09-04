/**
 * statsController — pulls live email statistics from Brevo's SMTP API.
 *
 * Brevo tracks delivered / opened / clicked / bounced automatically for every
 * transactional email. We query it per API key and aggregate across all the
 * accounts belonging to a company.
 *
 * Note: Brevo retains SMTP event data for ~30 days on free plans.
 */

const COMPANY_KEYS = {
  launcherdesk: () => [
    process.env.LD_BREVO_KEY_1,
    process.env.LD_BREVO_KEY_2,
    process.env.LD_BREVO_KEY_3,
  ].filter((k) => k && k.length > 10),
  officerestore: () => [
    process.env.OR_BREVO_KEY_1,
    process.env.OR_BREVO_KEY_2,
  ].filter((k) => k && k.length > 10),
};

const COMPANY_LABEL = {
  launcherdesk:  'Launcherdesk',
  officerestore: 'Officerestore',
};

async function brevoGet(apiKey, path) {
  try {
    const res  = await fetch(`https://api.brevo.com/v3${path}`, {
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: { message: e.message } };
  }
}

// ---------------------------------------------------------------------------
// GET /api/stats?company=launcherdesk&days=30
// Aggregated totals across every Brevo account for the company.
// ---------------------------------------------------------------------------
export async function getStats(req, res) {
  const company = req.query.company || 'launcherdesk';
  const days    = Math.min(90, Math.max(1, parseInt(req.query.days) || 30));

  const keysFn = COMPANY_KEYS[company];
  if (!keysFn) return res.status(400).json({ error: 'Unknown company.' });

  const keys = keysFn();
  if (keys.length === 0) {
    return res.status(400).json({ error: `No Brevo API keys configured for ${company}.` });
  }

  // Date range
  const end   = new Date();
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const fmt   = (d) => d.toISOString().slice(0, 10);

  const totals = {
    requests: 0, delivered: 0, opens: 0, uniqueOpens: 0,
    clicks: 0, uniqueClicks: 0, hardBounces: 0, softBounces: 0,
    spamReports: 0, blocked: 0, unsubscribed: 0,
  };

  const perAccount = [];

  for (let i = 0; i < keys.length; i++) {
    const path = `/smtp/statistics/aggregatedReport?startDate=${fmt(start)}&endDate=${fmt(end)}`;
    const { ok, body, status } = await brevoGet(keys[i], path);

    if (!ok) {
      perAccount.push({
        account: i + 1,
        error: body.message || `Brevo returned ${status}`,
      });
      continue;
    }

    const acc = {
      account:      i + 1,
      requests:     body.requests     || 0,
      delivered:    body.delivered    || 0,
      opens:        body.opens        || 0,
      uniqueOpens:  body.uniqueOpens  || 0,
      clicks:       body.clicks       || 0,
      uniqueClicks: body.uniqueClicks || 0,
      hardBounces:  body.hardBounces  || 0,
      softBounces:  body.softBounces  || 0,
      spamReports:  body.spamReports  || 0,
      blocked:      body.blocked      || 0,
      unsubscribed: body.unsubscribed || 0,
    };
    perAccount.push(acc);

    for (const k of Object.keys(totals)) totals[k] += acc[k] || 0;
  }

  // Derived rates
  const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
  const rates = {
    deliveryRate:  pct(totals.delivered,    totals.requests),
    openRate:      pct(totals.uniqueOpens,  totals.delivered),
    clickRate:     pct(totals.uniqueClicks, totals.delivered),
    bounceRate:    pct(totals.hardBounces + totals.softBounces, totals.requests),
    unsubRate:     pct(totals.unsubscribed, totals.delivered),
  };

  res.json({
    company,
    label: COMPANY_LABEL[company] || company,
    range: { days, startDate: fmt(start), endDate: fmt(end) },
    accounts: keys.length,
    totals,
    rates,
    perAccount,
  });
}

// ---------------------------------------------------------------------------
// GET /api/stats/events?company=launcherdesk&limit=100&event=opened
// Recent per-recipient events (opened, delivered, clicked, bounced...).
// ---------------------------------------------------------------------------
export async function getEvents(req, res) {
  const company = req.query.company || 'launcherdesk';
  const limit   = Math.min(200, Math.max(1, parseInt(req.query.limit) || 100));
  const event   = req.query.event || ''; // '' = all events
  const days    = Math.min(90, Math.max(1, parseInt(req.query.days) || 30));

  const keysFn = COMPANY_KEYS[company];
  if (!keysFn) return res.status(400).json({ error: 'Unknown company.' });

  const keys = keysFn();
  if (keys.length === 0) {
    return res.status(400).json({ error: `No Brevo API keys configured for ${company}.` });
  }

  const end   = new Date();
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const fmt   = (d) => d.toISOString().slice(0, 10);

  const all = [];

  for (let i = 0; i < keys.length; i++) {
    let path = `/smtp/statistics/events?limit=${limit}&startDate=${fmt(start)}&endDate=${fmt(end)}&sort=desc`;
    if (event) path += `&event=${encodeURIComponent(event)}`;

    const { ok, body } = await brevoGet(keys[i], path);
    if (!ok) continue;

    for (const e of body.events || []) {
      all.push({
        account:   i + 1,
        email:     e.email,
        event:     e.event,
        date:      e.date,
        subject:   e.subject || '',
        from:      e.from    || '',
        reason:    e.reason  || '',
        messageId: e.messageId || '',
      });
    }
  }

  // Newest first across all accounts
  all.sort((a, b) => new Date(b.date) - new Date(a.date));

  res.json({
    company,
    label: COMPANY_LABEL[company] || company,
    range: { days, startDate: fmt(start), endDate: fmt(end) },
    count: all.length,
    events: all.slice(0, limit),
  });
}
