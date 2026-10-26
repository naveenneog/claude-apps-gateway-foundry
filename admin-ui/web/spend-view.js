// Pure helpers for rows of GET /v1/organizations/spend_limits/effective, loaded before app.js as a classic script.
// Money values are strings in USD cents; period_to_date_spend may be fractional; amount null means unlimited
// (https://code.claude.com/docs/en/claude-apps-gateway-spend-limits). tests/admin-ui-web.test.mjs loads this file.
(() => {
  const list = (value) => (Array.isArray(value) ? value : []);

  // USD from cents with thousands separators; null or undefined is an unlimited cap.
  function usd(cents, decimals = 2) {
    if (cents === null || cents === undefined) return 'Unlimited';
    const [whole, fraction] = (Number(cents) / 100).toFixed(decimals).split('.');
    return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction}`;
  }

  // names: userNames()'s Map of OIDC subject to name; without one, or for a subject it lacks, the subject itself.
  function scopeText(scope, names) {
    if (!scope || scope.type === 'organization') return 'Organization';
    if (scope.type === 'rbac_group') return `Role ${scope.rbac_group_id}`;
    if (scope.type === 'user') return `User ${names?.get?.(scope.user_id) ?? scope.user_id}`;
    return scope.type;
  }

  const sameScope = (a, b) => a?.type === b?.type && (a?.user_id ?? null) === (b?.user_id ?? null)
    && (a?.rbac_group_id ?? null) === (b?.rbac_group_id ?? null);
  const capCents = (cap) => (cap.amount === null || cap.amount === undefined ? null : Number(cap.amount));

  globalThis.spendView = {
    usd,
    scopeText,

    // /effective rows to a Map of OIDC subject to the name the gateway recorded for it, else its e-mail address.
    userNames(rows) {
      const names = new Map();
      for (const r of list(rows)) {
        const name = r?.actor?.name || r?.actor?.email_address;
        if (r?.scope?.type === 'user' && r.scope.user_id && name) names.set(r.scope.user_id, name);
      }
      return names;
    },
    spendRow(row) {
      const source = row.source;
      return {
        name: row.actor?.name ?? row.actor?.email_address ?? row.scope?.user_id,
        email: row.actor?.email_address ?? '',
        period: row.period,
        spendCents: Number(row.period_to_date_spend ?? 0),
        capCents: row.amount === null || row.amount === undefined ? null : Number(row.amount),
        capSource: !source ? '—'
          : source.type === 'rbac_group' ? `rbac_group: ${source.rbac_group_id}`
          : source.type === 'user' ? 'user' : source.type,
        groups: (row.groups ?? []).join(', ') || '—',
      };
    },

    // The gateway keys a user cap by the OIDC subject (scope.user_id), not the e-mail address. An address is mapped
    // through the /effective rows, which hold both for every user the gateway has seen.
    resolveUserTarget(target, rows) {
      const value = String(target ?? '').trim();
      if (!value) throw new Error('A user cap needs a target: the user\'s e-mail address or OIDC subject.');
      if (!value.includes('@')) return value;
      const wanted = value.toLowerCase();
      const row = (rows ?? []).find((r) => (r.actor?.email_address ?? '').toLowerCase() === wanted);
      if (!row) throw new Error(`${value} has sent no request through the gateway yet, so its OIDC subject is unknown; enter the subject instead.`);
      return row.scope.user_id;
    },

    // One event of GET /v1/organizations/spend_limits/audit as a change: before null is a create, after null a delete.
    auditChange(event, names) {
      const cap = event?.after ?? event?.before ?? null;
      const at = new Date(event?.created_at ?? '');
      const actor = String(event?.actor ?? '');
      const key = /^admin-key:(.+)$/.exec(actor);
      return {
        when: Number.isNaN(at.getTime()) ? '' : `${at.toISOString().slice(0, 10)} ${at.toISOString().slice(11, 16)} UTC`,
        actor: key ? `${key[1]} (admin key)` : actor || '—',
        action: !event?.before ? 'Created' : !event?.after ? 'Removed' : 'Changed',
        scope: scopeText(cap?.scope, names),
        period: cap?.period ?? '',
        before: event?.before ? usd(capCents(event.before)) : '—',
        after: event?.after ? usd(capCents(event.after)) : '—',
      };
    },

    // GET /api/spend-limits caps counted by scope, e.g. "Organization 1 · Role 2 · User 1"; no scope is the organization.
    capBreakdown(caps) {
      const kinds = [['organization', 'Organization'], ['rbac_group', 'Role'], ['user', 'User']];
      const parts = kinds.map(([type, label]) => [label, list(caps).filter((c) => (c?.scope?.type ?? 'organization') === type).length])
        .filter(([, count]) => count > 0).map(([label, count]) => `${label} ${count}`);
      return parts.length ? parts.join(' · ') : 'None set, so spend is unlimited';
    },

    // The admin file's budgets (amountUsd, null unlimited) against the live caps of GET /api/spend-limits: whether
    // each is set as the file says, set differently, or missing (as after a restart on a temporary database), with
    // the POST /api/spend-limits body that sets it again.
    fileBudgets(budgets, caps) {
      return list(budgets).map((b) => {
        const scope = JSON.parse(JSON.stringify(b?.scope ?? { type: 'organization' }));
        const amountCents = b?.amountUsd === null || b?.amountUsd === undefined ? null : Math.round(Number(b.amountUsd) * 100);
        const live = list(caps).find((c) => sameScope(c.scope, scope) && c.period === b.period) ?? null;
        const liveCents = live ? capCents(live) : null;
        return {
          scope: scopeText(scope),
          period: b.period,
          amount: usd(amountCents),
          live: live ? usd(liveCents) : '—',
          status: !live ? 'missing' : liveCents === amountCents ? 'set' : 'differs',
          body: { scope, amountCents, period: b.period },
        };
      });
    },
  };
})();
