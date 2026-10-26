// The Developers page: who holds a gateway app role in Entra ID (GET /api/developers), and granting or removing one
// (POST and DELETE /api/developers; the server reuses scripts/admin/set-developer.mjs). The role choices are the
// admitted roles (GET /api/roles), so a role created and admitted in admin-ui is offered without a redeploy.
const developersPage = (() => {
  async function render(ctx) {
    const body = el('div', {}, [ui.skeleton('table', 4)]);
    const chips = el('div', { class: 'chip-row' });
    const search = el('input', { type: 'search', placeholder: 'Filter by name or role', 'aria-label': 'Filter role holders', autocomplete: 'off' });
    let developers = [];
    const form = grantForm(() => refresh());
    ctx.root.replaceChildren(
      ui.pageHeader({ title: 'Developers', description: 'People who hold a gateway app role in Entra ID. The role decides which models and apps they can use.' }),
      form.node,
      ui.card({ title: 'Role holders', actions: [el('div', { class: 'search' }, [ui.icon('filter', 14), search])], content: [chips, body], className: 'flush' }));

    function draw() {
      const q = search.value.trim().toLowerCase();
      const shown = developers.filter((d) => !q || `${d.name} ${d.role}`.toLowerCase().includes(q));
      const counts = new Map();
      for (const d of developers) counts.set(d.role, (counts.get(d.role) ?? 0) + 1);
      chips.replaceChildren(...[...counts].map(([role, n]) => el('span', { class: 'chip' }, [el('code', { text: role }), el('span', { text: String(n) })])));
      chips.hidden = !counts.size;
      if (!developers.length) { body.replaceChildren(ui.empty('No one holds a gateway role yet', 'Grant a role above.')); return; }
      if (!shown.length) { body.replaceChildren(ui.empty('No match', `No role holder matches “${search.value.trim()}”.`)); return; }
      body.replaceChildren(ui.table({
        caption: 'Role holders',
        columns: [
          { label: 'Name', render: (d) => el('div', { class: 'who' }, [el('strong', { text: d.name || 'Unnamed' }), el('span', { class: 'mono', text: d.principalId })]) },
          { label: 'Role', render: (d) => ui.pill(d.role, 'info') },
          { label: '', className: 'actions', render: (d) => ui.button('Remove', { kind: 'danger', size: 'sm', iconName: 'trash', 'aria-label': `Remove ${d.role} from ${d.name}`, onclick: () => remove(d) }) },
        ],
        rows: [...shown].sort((a, b) => a.role.localeCompare(b.role) || String(a.name).localeCompare(String(b.name))),
      }));
    }
    search.addEventListener('input', draw);

    async function refresh() {
      const result = await ui.settle(api.get('/api/developers'));
      if (!ctx.active()) return;
      if (result instanceof Error) { body.replaceChildren(ui.banner('error', `Could not load role holders: ${result.message}`)); return; }
      developers = result.developers ?? [];
      draw();
    }

    async function remove(d) {
      const ok = await ui.confirm({
        title: `Remove ${d.role}?`, body: [`${d.name} loses the ${d.role} app role assignment in Entra ID.`],
        confirmText: 'Remove role', danger: true,
      });
      if (!ok) return;
      try {
        // The listing carries no UPN (Graph's appRoleAssignedTo returns none), only principalId (the user's object ID).
        // GET /users/{id | userPrincipalName} accepts either (https://learn.microsoft.com/en-us/graph/api/user-get).
        await api.del('/api/developers', { upn: d.principalId, role: d.role });
        ui.toast(`Removed ${d.role} from ${d.name}`);
      } catch (err) {
        ui.toast(`Could not remove ${d.role} from ${d.name}: ${err.message}`, 'error');
      }
      await refresh();
    }

    const [roles, config] = await Promise.all([ui.settle(ui.shared('/api/roles')), ui.settle(ui.shared('/api/gateway-config'))]);
    if (!ctx.active()) return;
    form.setRoles(rolesView.choices(roles instanceof Error ? null : roles, config instanceof Error ? null : config.admin));
    await refresh();
  }

  function grantForm(onSaved) {
    const upn = el('input', { name: 'upn', placeholder: 'e.g. dev@contoso.com', autocomplete: 'off', spellcheck: 'false', inputmode: 'email' });
    let role = el('select', { name: 'role', disabled: true }, [el('option', { value: '', text: 'Loading roles…' })]);
    const submit = ui.button('Grant role', { kind: 'primary', type: 'submit', iconName: 'plus' });
    const status = el('div', { class: 'form-status' });
    const roleField = ui.field({ label: 'Role', control: role, className: 'wide', hint: 'The admitted gateway roles. Roles has the models each one allows.' });
    const form = el('form', { class: 'form-grid', novalidate: true }, [
      ui.field({ label: 'User principal name', control: upn, className: 'wide', hint: 'The user’s sign-in name in Entra ID.' }),
      roleField,
      el('div', { class: 'form-actions' }, [submit]),
    ]);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      status.replaceChildren();
      ui.setFieldError(upn, '');
      const who = upn.value.trim();
      const what = role.value.trim();
      if (!who) { ui.setFieldError(upn, 'Enter the user’s principal name.'); upn.focus(); return; }
      if (!what) { ui.setFieldError(role, 'Choose a role.'); role.focus(); return; }
      ui.busy(submit, true, 'Granting…');
      try {
        await api.post('/api/developers', { upn: who, role: what });
        ui.toast(`Granted ${what} to ${who}`);
        upn.value = '';
        await onSaved();
      } catch (err) {
        status.replaceChildren(ui.banner('error', `Could not grant ${what} to ${who}: ${err.message}`));
      } finally {
        ui.busy(submit, false);
      }
    });
    return {
      node: ui.card({ title: 'Grant a role', description: 'Assigns the gateway app role to the user in Entra ID.', content: [status, form] }),
      setRoles(choices) {
        const describedBy = role.getAttribute('aria-describedby');
        const next = choices
          ? el('select', { name: 'role', id: role.id, 'aria-describedby': describedBy, disabled: !choices.length }, choices.length
            ? choices.map((c) => el('option', { value: c.value, text: c.label ? `${c.value} — ${c.label}` : c.value }))
            : [el('option', { value: '', text: 'No admitted roles' })])
          : el('input', { name: 'role', id: role.id, placeholder: 'e.g. Gateway.Standard', 'aria-describedby': describedBy });
        role.replaceWith(next);
        role = next;
      },
    };
  }

  return { title: 'Developers', render };
})();
