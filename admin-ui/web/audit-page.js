// The Audit page: the gateway's own record of spend-cap changes (GET /api/spend-limits/audit), read as changes rather
// than raw JSON; the raw event stays one click away.
const auditPage = (() => {
  async function render(ctx) {
    ctx.root.replaceChildren(
      ui.pageHeader({ title: 'Audit', description: 'Changes to spend caps, as the gateway records them. The latest 50 are shown.' }),
      ui.skeleton('table', 6), ui.loading('Loading the audit trail'));
    const [audit, config, effective] = await Promise.all([
      ui.settle(api.get('/api/spend-limits/audit?limit=50')), ui.settle(ui.shared('/api/gateway-config')),
      ui.settle(api.get('/api/spend-limits/effective?period[]=monthly&limit=1000')),
    ]);
    if (!ctx.active()) return;
    const names = spendView.userNames(effective instanceof Error ? [] : effective.data);
    const notes = [];
    if (!(config instanceof Error) && config.restart?.temporaryDatabase) {
      notes.push(ui.banner('warning', 'This gateway keeps its database on temporary storage, so the audit trail starts again with each new revision.'));
    }
    notes.push(ui.banner('info', 'Gateway configuration and role changes are not listed here. Azure records them in the Activity log, and Entra ID in its audit logs.'));
    let content;
    if (audit instanceof Error) content = ui.banner('error', `Could not load the audit trail: ${audit.message}`);
    else if (!audit.data?.length) content = ui.empty('No changes recorded', 'Changes to spend caps appear here.');
    else {
      const kind = { Created: 'ok', Changed: 'info', Removed: 'danger' };
      content = ui.table({
        caption: 'Spend-cap changes', className: 'audit',
        columns: [
          { label: 'When', className: 'nowrap mono', render: ({ c }) => c.when },
          { label: 'Actor', render: ({ c }) => c.actor },
          { label: 'Change', render: ({ c }) => ui.pill(c.action, kind[c.action]) },
          { label: 'Scope', render: ({ c }) => el('div', { class: 'who' }, [el('strong', { text: c.scope }), el('span', { text: c.period })]) },
          { label: 'Amount', className: 'num', render: ({ c }) => el('span', { class: 'delta' }, [el('span', { class: 'muted', text: c.before }), ui.icon('arrow', 13), el('strong', { text: c.after })]) },
          { label: '', className: 'actions', render: ({ e }) => el('details', { class: 'raw' }, [el('summary', { text: 'JSON' }), el('pre', { class: 'code-block', text: JSON.stringify({ before: e.before, after: e.after }, null, 2) })]) },
        ],
        rows: audit.data.map((e) => ({ e, c: spendView.auditChange(e, names) })),
      });
    }
    ctx.root.replaceChildren(
      ui.pageHeader({ title: 'Audit', description: 'Changes to spend caps, as the gateway records them. The latest 50 are shown.' }),
      ...notes, ui.card({ title: 'Spend-cap changes', content, className: 'flush' }));
  }

  return { title: 'Audit', render };
})();
