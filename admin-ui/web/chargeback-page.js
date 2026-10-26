// The Chargeback page: spend per business unit for the current period to date (GET /api/chargeback), grouped by an
// Entra ID attribute or by gateway role, the per-user rows behind it, CSV export, and - when admin-ui may write users
// - tagging a user's department and cost center (PATCH /api/users/{upn}). Every amount is the API's own.
const chargebackPage = (() => {
  const state = { period: 'monthly', groupBy: 'department', group: null, editing: null };
  const cb = () => chargebackView;
  const UNRESOLVED_TEXT = 'Unresolved users have no e-mail address recorded by the gateway yet, or were not found in Entra ID. Their spend is in the total.';

  async function render(ctx) {
    const option = (o, current) => el('option', { value: o.value, text: o.label, selected: o.value === current });
    const period = el('select', { name: 'period' }, cb().PERIODS.map((o) => option(o, state.period)));
    const groupBy = el('select', { name: 'groupBy' }, cb().GROUP_BY.map((o) => option(o, state.groupBy)));
    const exportCsv = ui.button('Export CSV', { kind: 'secondary', iconName: 'download' });
    const body = el('div', { class: 'stack' });
    const stamp = el('span', { class: 'toolbar-meta', 'aria-live': 'polite' });
    let report = null;
    let units = null;
    let token = 0;
    const unitsBody = el('div', { class: 'stack' });

    async function loadUnits() {
      unitsBody.replaceChildren(ui.skeleton('table', 3));
      const result = await ui.settle(api.get('/api/business-units'));
      if (!ctx.active()) return;
      units = result instanceof Error ? result : cb().businessUnits(result);
      drawUnits();
    }

    function drawUnits() {
      if (units instanceof Error) {
        unitsBody.replaceChildren(ui.banner('error', [units.message], { title: 'Could not list business units', actions: [ui.settingsLink()] }));
        return;
      }
      const editable = units.rows.some((r) => r.editable);
      const datalist = el('datalist', { id: 'business-unit-options' }, units.options.map((o) => el('option', { value: o })));
      const chips = units.units.length
        ? el('div', { class: 'pills', role: 'list', 'aria-label': 'Business units' }, units.units.map((u) => el('span', { role: 'listitem' }, [ui.pill(`${u.name} · ${u.usersText}`, 'info')])))
        : el('p', { class: 'muted', text: 'No business units yet.' });
      const columns = [
        { label: 'User', render: (r) => el('div', { class: 'who' }, [el('strong', { text: r.name }), r.detail ? el('span', { text: r.detail }) : null]) },
        { label: 'Business unit (department)', render: (r) => tagCell(r, 'department') },
        { label: 'Cost center', render: (r) => tagCell(r, 'costCenter') },
        { label: 'Roles', render: (r) => r.roles },
        editable ? { label: '', className: 'actions', render: (r) => actionsCell(r) } : null,
      ].filter(Boolean);
      unitsBody.replaceChildren(
        datalist,
        el('div', { class: 'card-body stack' }, [
          chips,
          units.unassignedText ? el('p', { class: 'note warn' }, [ui.icon('warning', 14), el('span', { text: units.unassignedText })]) : null,
          units.skippedText ? el('p', { class: 'muted small', text: units.skippedText }) : null,
          editable ? null : el('p', { class: 'muted small', text: cb().tagHint({ canTag: false }) }),
        ]),
        units.rows.length ? ui.table({ caption: 'Gateway users and their business units', columns, rows: units.rows }) : ui.empty('No gateway users', 'Assign a gateway role on Access & models first.'));
    }

    function redraw() {
      if (report) draw();
      if (units && !(units instanceof Error)) drawUnits();
    }

    async function load() {
      const mine = (token += 1);
      state.editing = null;
      if (units && !(units instanceof Error)) drawUnits();
      body.replaceChildren(ui.skeleton('cards', 4), ui.skeleton('table', 5), ui.loading('Loading chargeback'));
      const result = await ui.settle(api.get(cb().dataHref(state.period, state.groupBy)));
      if (!ctx.active() || mine !== token) return;
      if (result instanceof Error) {
        report = null;
        stamp.textContent = '';
        body.replaceChildren(ui.banner('error', [result.message], { title: 'Could not build the chargeback report', actions: [ui.settingsLink()] }));
        return;
      }
      report = result;
      if (state.group && !report.groups?.some((g) => g.key === state.group)) state.group = null;
      const at = new Date(report.generatedAt ?? '');
      stamp.textContent = Number.isNaN(at.getTime()) ? '' : `Generated ${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
      draw();
    }

    function draw() {
      const groupMeta = cb().GROUP_BY.find((g) => g.value === report.groupBy) ?? cb().GROUP_BY[0];
      const sum = cb().summary(report);
      const periodLabel = cb().PERIODS.find((p) => p.value === report.period)?.label ?? report.period;
      const metric = (label, value, sub, kind = '') => el('div', { class: `card metric-card ${kind}`.trim() }, [
        el('div', { class: 'metric-label', text: label }), el('div', { class: 'metric-value', text: value }), el('div', { class: 'metric-sub', text: sub }),
      ]);
      body.replaceChildren(
        el('div', { class: 'metrics four' }, [
          metric('Total', sum.total, `${periodLabel} · ${report.currency ?? 'USD'}`),
          metric('Users with spend', String(sum.users), 'From the gateway’s per-user totals'),
          metric(`${groupMeta.label === 'Gateway role' ? 'Role combinations' : `${groupMeta.label}s`}`, String(sum.groups), `Grouped by ${groupMeta.label.toLowerCase()}`),
          metric('Unresolved users', String(sum.unresolved), sum.unresolved ? `${sum.unresolvedTotal} of spend` : 'Every user found in Entra ID', sum.unresolved ? 'attention' : ''),
        ]),
        breakdown(groupMeta),
        usersCard(groupMeta),
        ...(report.notes?.length ? [el('div', { class: 'footnotes' }, [
          el('h3', { class: 'footnotes-title', text: 'Report notes' }),
          el('ul', {}, report.notes.map((n) => el('li', { text: String(n) }))),
        ])] : []));
    }

    function breakdown(groupMeta) {
      const groups = cb().groupsForDisplay(report);
      const items = groups.map((g) => {
        const fill = el('span', { class: 'bar-fill' });
        fill.style.setProperty('--pct', `${g.barPct}%`);
        const pressed = state.group === g.key;
        return el('li', { class: ['bar-row', g.special, pressed ? 'selected' : ''].filter(Boolean).join(' ') }, [
          el('button', { type: 'button', class: 'bar-button', 'aria-pressed': String(pressed), onclick: () => { state.group = pressed ? null : g.key; draw(); } }, [
            el('span', { class: 'bar-label' }, [el('strong', { text: g.label, title: g.label }), el('span', { text: g.usersText })]),
            el('span', { class: 'bar-track', 'aria-hidden': 'true' }, [fill]),
            el('span', { class: 'bar-share', text: g.share }),
            el('span', { class: 'bar-total', text: g.total }),
          ]),
        ]);
      });
      const unresolved = groups.some((g) => g.special === 'unresolved');
      return ui.card({
        title: `By ${groupMeta.label.toLowerCase()}`, description: 'Share of the total. Select a row to list its users.',
        content: el('div', { class: 'card-body' }, [
          groups.length ? el('ul', { class: 'bars' }, items) : ui.empty('No spend in this period', 'Nothing to charge back yet.'),
          unresolved ? el('p', { class: 'note warn' }, [ui.icon('warning', 14), el('span', { text: UNRESOLVED_TEXT })]) : null,
        ]),
      });
    }

    function usersCard(groupMeta) {
      const rows = cb().rowsForDisplay(report, state.group);
      const label = state.group ? cb().groupLabel(state.group, report.groupBy) : null;
      const clear = state.group ? ui.button('Show all users', { kind: 'ghost', size: 'sm', iconName: 'x', onclick: () => { state.group = null; draw(); } }) : null;
      const hint = cb().tagHint(report);
      const own = ['department', 'costCenter'].includes(report.groupBy);
      const columns = [
        { label: 'User', render: (r) => el('div', { class: 'who' }, [
          el('strong', {}, [r.name, r.unresolved ? ui.pill('Unresolved', 'warn') : null]), r.detail ? el('span', { text: r.detail }) : null,
        ]) },
        own ? null : { label: groupMeta.label, render: (r) => (r.special ? el('span', { class: 'muted', text: r.group }) : r.group) },
        { label: 'Department', render: (r) => tagCell(r, 'department') },
        { label: 'Cost center', render: (r) => tagCell(r, 'costCenter') },
        { label: 'Roles', render: (r) => r.roles },
        { label: 'Spend', className: 'num', render: (r) => r.spend },
        { label: 'Cap', className: 'num', render: (r) => el('div', { class: 'cap-cell' }, [r.cap, r.capPct === null ? null : el('span', { class: 'muted small', text: `${r.capPct}% used` })]) },
        report.canTag ? { label: '', className: 'actions', render: (r) => actionsCell(r) } : null,
      ].filter(Boolean);
      return ui.card({
        title: label ? `Users · ${label}` : 'Users', className: 'flush',
        description: hint ?? 'Department and cost center are the users’ Entra ID attributes. Edit sets them in Entra ID.',
        actions: [clear].filter(Boolean),
        content: rows.length
          ? ui.table({ caption: 'Spend per user', columns, rows, rowAttrs: (r) => ({ class: r.unresolved ? 'row-warn' : null }) })
          : ui.empty('No users', 'No user has spend in this period.'),
      });
    }

    function tagCell(r, key) {
      if (state.editing === r.userId) {
        const input = el('input', { class: 'compact', name: key, value: r[key], 'aria-label': `${key === 'department' ? 'Department' : 'Cost center'} for ${r.name}`, 'data-tag': key, maxlength: key === 'department' ? '64' : null, list: key === 'department' ? 'business-unit-options' : null });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') { state.editing = null; redraw(); }
          if (e.key === 'Enter') { e.preventDefault(); save(r, e.currentTarget.closest('tr')); }
        });
        return el('div', { class: 'tag-edit' }, [input, el('p', { class: 'field-error', 'data-error': key })]);
      }
      if (r.unresolved) return el('span', { class: 'muted', text: '—' });
      return r[key] ? r[key] : el('span', { class: 'muted', text: 'Not set' });
    }

    function actionsCell(r) {
      if (!r.editable) return el('span', { class: 'muted small', title: UNRESOLVED_TEXT, text: r.unresolved ? 'Not in Entra' : '' });
      if (state.editing !== r.userId) {
        return ui.button('Edit', { kind: 'ghost', size: 'sm', iconName: 'edit', 'aria-label': `Edit department and cost center for ${r.name}`, onclick: () => {
          state.editing = r.userId;
          redraw();
          ctx.root.querySelector(`tr input[data-tag="department"]`)?.focus();
        } });
      }
      return el('div', { class: 'row-actions' }, [
        ui.button('Cancel', { kind: 'ghost', size: 'sm', onclick: () => { state.editing = null; redraw(); } }),
        ui.button('Save', { kind: 'primary', size: 'sm', onclick: (e) => save(r, e.currentTarget.closest('tr'), e.currentTarget) }),
      ]);
    }

    async function save(r, tr, btn) {
      const edits = Object.fromEntries([...tr.querySelectorAll('input[data-tag]')].map((i) => [i.dataset.tag, i.value]));
      const errors = cb().tagErrors(edits);
      for (const node of tr.querySelectorAll('[data-error]')) node.textContent = errors[node.dataset.error] ?? '';
      if (Object.keys(errors).length) return;
      const patch = cb().tagPatch(r, edits);
      if (!patch) { state.editing = null; redraw(); return; }
      if (btn) ui.busy(btn, true, 'Saving…');
      try {
        await api.patch(`/api/users/${encodeURIComponent(r.upn)}`, patch);
        ui.toast(`Saved for ${r.name}. Entra ID may take a moment to return the new values.`);
        await Promise.all([load(), loadUnits()]);
      } catch (err) {
        if (btn) ui.busy(btn, false);
        ui.toast(`Could not save for ${r.name}: ${err.message}`, 'error');
      }
    }

    period.addEventListener('change', () => { state.period = period.value; load(); });
    groupBy.addEventListener('change', () => { state.groupBy = groupBy.value; state.group = null; load(); });
    exportCsv.addEventListener('click', async () => {
      ui.busy(exportCsv, true, 'Exporting…');
      try {
        const res = await fetch(cb().csvHref(state.period, state.groupBy), { headers: { Accept: 'text/csv' } });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
        const named = /filename="?([^";]+)"?/.exec(res.headers.get('Content-Disposition') ?? '')?.[1];
        ui.download(named || cb().csvFileName(state.period, state.groupBy, report?.generatedAt), await res.text(), 'text/csv');
      } catch (err) {
        ui.toast(`Could not export the CSV: ${err.message}`, 'error');
      } finally {
        ui.busy(exportCsv, false);
      }
    });

    ctx.root.replaceChildren(
      ui.pageHeader({ title: 'Chargeback', description: 'Spend per business unit, from the gateway’s per-user totals and the users’ Entra ID attributes.', actions: [exportCsv] }),
      el('div', { class: 'toolbar' }, [ui.field({ label: 'Period', control: period }), ui.field({ label: 'Group by', control: groupBy }), stamp]),
      ui.banner('info', ['Amounts are the gateway’s list-price estimates for the current period to date, not the Azure invoice. Past periods are not available from the gateway.']),
      body,
      ui.card({
        title: 'Business units',
        description: 'A business unit is the user’s Entra ID department; Group by Department uses it. Everyone with a gateway role is listed, spend or not. Edit a user and type a new name to create a unit, or pick an existing one.',
        content: unitsBody,
      }));
    await Promise.all([load(), loadUnits()]);
  }

  return { title: 'Chargeback', render };
})();
