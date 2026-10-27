// Pure helpers for the Chargeback page: GET /api/chargeback's report (admin-ui/server/chargeback.mjs) as shown on
// screen, and the PUT /api/user-tags body that sets a user's business-unit tags in the gateway database (ADR-0015). Amounts are USD cents and may be
// fractional; every total shown is the API's own, never re-added here. Loaded before app.js as a classic script;
// tests/admin-ui-web.test.mjs loads it in node:vm.
(() => {
  const UNRESOLVED = '(unresolved)';
  const UNASSIGNED = '(unassigned)';
  const GROUP_BY = [
    { value: 'department', label: 'Department', noun: 'department' },
    { value: 'companyName', label: 'Company', noun: 'company' },
    { value: 'officeLocation', label: 'Office', noun: 'office' },
    { value: 'costCenter', label: 'Cost center', noun: 'cost center' },
    { value: 'division', label: 'Division', noun: 'division' },
    { value: 'role', label: 'Gateway role', noun: 'gateway role' },
  ];
  const PERIODS = [
    { value: 'monthly', label: 'Month to date' },
    { value: 'weekly', label: 'Week to date' },
    { value: 'daily', label: 'Today' },
  ];
  // The five business-unit tags (admin-ui/server/user-tags.mjs), each 1 to 64 characters; gateway role is not a tag.
  const TAGS = [
    { key: 'department', label: 'Department' },
    { key: 'costCenter', label: 'Cost center' },
    { key: 'companyName', label: 'Company' },
    { key: 'officeLocation', label: 'Office' },
    { key: 'division', label: 'Division' },
  ];
  const TAG_MAX = 64;

  const list = (value) => (Array.isArray(value) ? value : []);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const special = (key) => (key === UNRESOLVED ? 'unresolved' : key === UNASSIGNED ? 'unassigned' : null);

  function formatUsd(cents, decimals = 2) {
    if (cents === null || cents === undefined || cents === '' || !Number.isFinite(Number(cents))) return '—';
    const [whole, fraction] = (Number(cents) / 100).toFixed(decimals).split('.');
    const negative = whole.startsWith('-');
    const grouped = (negative ? whole.slice(1) : whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `${negative ? '-' : ''}$${grouped}${fraction ? `.${fraction}` : ''}`;
  }

  function groupLabel(key, groupBy) {
    if (key === UNRESOLVED) return 'Unresolved users';
    if (key === UNASSIGNED) return `No ${GROUP_BY.find((g) => g.value === groupBy)?.noun ?? 'value'}`;
    return key;
  }

  const share = (pct) => {
    const n = Number(pct) || 0;
    return `${Number.isInteger(n) ? n : n.toFixed(1)}%`;
  };

  const chargebackView = {
    TAGS,
    GROUP_BY,
    PERIODS,
    formatUsd,
    groupLabel,

    // The API's groups in its order (largest first), with no attribute and then unresolved users last, never dropped.
    groupsForDisplay(report) {
      const rank = (g) => (g.key === UNRESOLVED ? 2 : g.key === UNASSIGNED ? 1 : 0);
      return list(report?.groups).map((g, i) => [g, i]).sort(([a, i], [b, j]) => rank(a) - rank(b) || i - j).map(([g]) => ({
        key: g.key,
        label: groupLabel(g.key, report.groupBy),
        total: formatUsd(g.totalCents),
        share: share(g.sharePct),
        barPct: Math.max(0, Math.min(100, Number(g.sharePct) || 0)),
        users: g.users,
        usersText: plural(Number(g.users) || 0, 'user', 'users'),
        special: special(g.key),
      }));
    },

    summary(report) {
      const rows = list(report?.rows);
      const unresolved = rows.filter((r) => r.resolved !== true);
      return {
        total: formatUsd(report?.totalCents),
        users: rows.length,
        groups: list(report?.groups).filter((g) => !special(g.key)).length,
        unresolved: unresolved.length,
        unresolvedTotal: formatUsd(unresolved.reduce((sum, r) => sum + (Number(r.spendCents) || 0), 0)),
      };
    },

    // Highest spend first; groupKey narrows to one business unit. detail is the line under the name: the address unless
    // the name already is it. Read-only: tags are edited under Business units.
    rowsForDisplay(report, groupKey) {
      const rows = list(report?.rows).filter((r) => !groupKey || r.groupKey === groupKey);
      return rows.map((r, i) => [r, i]).sort(([a, i], [b, j]) => (Number(b.spendCents) || 0) - (Number(a.spendCents) || 0) || i - j).map(([r]) => {
        const capped = r.capCents !== null && r.capCents !== undefined;
        const name = r.name || r.email || r.userId;
        return {
          userId: r.userId,
          name,
          email: r.email || '—',
          detail: !r.email ? 'No e-mail recorded' : name === r.email ? null : r.email,
          groupKey: r.groupKey,
          group: groupLabel(r.groupKey, report.groupBy),
          special: special(r.groupKey),
          roles: list(r.roles).join(', ') || '—',
          spend: formatUsd(r.spendCents, 4),
          cap: capped ? formatUsd(r.capCents) : 'Unlimited',
          capPct: capped && Number(r.capCents) > 0 ? Math.min(100, Math.round((Number(r.spendCents) / Number(r.capCents)) * 100)) : null,
          unresolved: r.resolved !== true,
          ...Object.fromEntries(TAGS.map((tag) => [tag.key, r[tag.key] ?? ''])),
        };
      });
    },

    // The PUT /api/user-tags/{objectId} body: only the tags that changed, an emptied one as null; null if none did.
    tagPatch(row, edits) {
      const patch = {};
      for (const { key } of TAGS) {
        if (!edits || !(key in edits)) continue;
        const value = String(edits[key] ?? '').trim();
        const next = value === '' ? null : value;
        if (next !== (row?.[key] || null)) patch[key] = next;
      }
      return Object.keys(patch).length ? patch : null;
    },

    tagErrors(edits) {
      const errors = {};
      for (const { key } of TAGS) {
        const value = String(edits?.[key] ?? '').trim();
        if (value.length > TAG_MAX) errors[key] = `Use at most ${TAG_MAX} characters.`;
        else if (/[\x00-\x1f\x7f]/.test(value)) errors[key] = 'Remove control characters.';
      }
      return errors;
    },

    // Why tags cannot be edited: the server's reason (no managed database), else an administrator must sign in.
    tagHint(report) {
      if (report?.canTag === true) return null;
      return report?.tagsReason || 'Tags are read-only here: sign in to the console as an administrator (AdminUi.Admin) to set them.';
    },

    // GET /api/business-units as shown: units by name, rows by unit (none last) then name. A row has the fields the
    // Chargeback page's tag editor reads (userId, name, the five tags, editable).
    businessUnits(data) {
      const units = list(data?.units).map((u) => ({ name: u.name, usersText: plural(Number(u.users) || 0, 'user', 'users') }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const n = Number(data?.unassigned) || 0;
      const skipped = list(data?.skipped).map((s) => s.name || s.principalId);
      const rows = list(data?.users).map((u) => ({
        userId: u.id, upn: u.upn || u.id, name: u.name || u.upn || u.id, detail: u.upn && u.upn !== u.name ? u.upn : null,
        roles: list(u.roles).join(', ') || '—', ...Object.fromEntries(TAGS.map((tag) => [tag.key, u[tag.key] ?? ''])),
        editable: data?.canTag === true, unresolved: false,
      })).sort((a, b) => (a.department ? 0 : 1) - (b.department ? 0 : 1) || a.department.localeCompare(b.department) || a.name.localeCompare(b.name));
      return {
        units,
        options: units.map((u) => u.name),
        unassignedText: n ? `${plural(n, 'user has', 'users have')} no business unit` : null,
        skippedText: skipped.length ? `Groups with a gateway role are not listed: ${skipped.join(', ')}. To tag their members, give each member the role directly, or import their tags from a CSV file.` : null,
        rows,
      };
    },

    dataHref(period, groupBy) { return `/api/chargeback?period=${encodeURIComponent(period)}&groupBy=${encodeURIComponent(groupBy)}`; },
    csvHref(period, groupBy) { return `/api/chargeback?format=csv&period=${encodeURIComponent(period)}&groupBy=${encodeURIComponent(groupBy)}`; },
    csvFileName(period, groupBy, generatedAt) {
      const day = /^\d{4}-\d{2}-\d{2}/.exec(String(generatedAt ?? ''))?.[0] ?? 'report';
      return `chargeback-${period}-${groupBy}-${day}.csv`;
    },
  };

  globalThis.chargebackView = chargebackView;
})();
