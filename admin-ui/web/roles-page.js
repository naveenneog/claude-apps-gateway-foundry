// The Roles page: the Entra app roles on the gateway's app registration (GET /api/roles), whether each is admitted and
// what it allows, and creating one (POST /api/roles). Admitting a role and choosing its models happens in Access &
// models; admin-ui does not delete or disable roles.
const rolesPage = (() => {
  const DESCRIPTION = 'App roles on the gateway’s Entra app registration. A developer needs an admitted role to use the gateway.';
  let created = null;

  async function render(ctx) {
    const create = ui.button('Create role', { kind: 'primary', iconName: 'plus', disabled: true });
    const header = ui.pageHeader({ title: 'Roles', description: DESCRIPTION, actions: [create] });
    ctx.root.replaceChildren(header, ui.skeleton('table', 4), ui.loading('Loading roles'));
    const [roles, config, caps] = await Promise.all([
      ui.settle(ui.shared('/api/roles', { fresh: true })), ui.settle(ui.shared('/api/gateway-config')), ui.settle(ui.shared('/api/capabilities')),
    ]);
    if (!ctx.active()) return;
    if (roles instanceof Error) {
      ctx.root.replaceChildren(header, ui.banner('error', [`Could not list the app roles: ${roles.message}`], { actions: [ui.settingsLink()] }));
      return;
    }
    const blocker = rolesView.createBlocker(roles, caps instanceof Error ? null : caps);
    create.disabled = Boolean(blocker);
    create.addEventListener('click', () => openCreate(ctx, roles));
    const parts = [header];
    const fresh = created && roles.roles.find((r) => r.value === created && !r.admitted);
    if (fresh) {
      parts.push(ui.banner('success', [`${fresh.value} is not admitted yet. Admit it and choose its models in Access & models.`], {
        title: `Created ${fresh.value}`, actions: [admitLink(fresh.value, 'primary')],
      }));
    }
    if (blocker) parts.push(ui.banner('info', [blocker], { title: 'Creating roles is unavailable', actions: [ui.settingsLink()] }));
    const rows = rolesView.roleRows(roles, config instanceof Error ? null : config.admin);
    const canEdit = !configView.readOnlyReason(config instanceof Error ? null : config, caps instanceof Error ? null : caps);
    parts.push(ui.card({
      title: 'App roles', className: 'flush',
      description: 'admin-ui does not delete or disable roles. Do that in the Entra admin center: App registrations > the gateway’s app > App roles.',
      content: rows.length ? table(rows, canEdit) : ui.empty('No app roles', 'Create one to start.'),
    }));
    ctx.root.replaceChildren(...parts);
  }

  function admitLink(value, kind = 'secondary') {
    return el('a', { class: `btn ${kind} sm`, href: `#/access?admit=${encodeURIComponent(value)}` }, [el('span', { text: 'Admit with models…' })]);
  }

  function modelChips(text) {
    if (['—', 'None', 'All models'].includes(text)) return el('span', { class: text === 'All models' ? '' : 'muted', text });
    return el('div', { class: 'chips' }, text.split(', ').map((m) => el('code', { text: m })));
  }

  // canEdit: whether the Access & models page can change the configuration; without it the actions only lead there to look.
  function table(rows, canEdit) {
    return ui.table({
      caption: 'App roles',
      columns: [
        { label: 'Role', className: 'wrap', render: (r) => el('div', { class: 'who' }, [
          el('code', { class: 'strong', text: r.value }), r.displayName && el('span', { text: r.displayName }),
          r.description && el('p', { class: 'who-note', text: r.description }),
        ]) },
        { label: 'Status', render: (r) => el('div', { class: 'pills' }, [
          r.admitted ? ui.pill('Admitted', 'ok') : ui.pill('Not admitted', ''),
          r.enabled ? null : ui.pill('Disabled in Entra', 'danger'),
        ]) },
        { label: 'Models', render: (r) => modelChips(r.models) },
        { label: 'Claude Desktop', render: (r) => (r.desktop === 'Allowed' ? ui.pill('Allowed', 'ok') : el('span', { class: 'muted', text: r.desktop })) },
        { label: '', className: 'actions', render: (r) => {
          const access = (text) => el('a', { class: 'btn ghost sm', href: '#/access' }, [el('span', { text }), ui.icon('arrow', 14)]);
          if (!canEdit) return r.admitted ? access('View access') : null;
          if (r.admitted) return access('Edit access');
          return r.enabled ? admitLink(r.value) : el('span', { class: 'muted small', text: 'Enable in Entra first' });
        } },
      ],
      rows,
      rowAttrs: (r) => ({ class: r.enabled ? null : 'dim' }),
    });
  }

  function openCreate(ctx, roles) {
    const value = el('input', { name: 'value', placeholder: 'e.g. Gateway.Trial', autocomplete: 'off', spellcheck: 'false', maxlength: '120' });
    const displayName = el('input', { name: 'displayName', placeholder: 'e.g. Gateway trial', autocomplete: 'off', maxlength: '256' });
    const description = el('textarea', { name: 'description', rows: '3', placeholder: 'e.g. Trial access to the Claude apps gateway', maxlength: '256' });
    const status = el('div', { class: 'form-status' });
    const formId = ui.uid('create-role');
    const submit = ui.button('Create role', { kind: 'primary', type: 'submit', form: formId });
    const cancel = ui.button('Cancel');
    const controls = { value, displayName, description };
    const check = () => {
      const errors = rolesView.formErrors({ value: value.value, displayName: displayName.value, description: description.value }, roles.roles);
      for (const [key, control] of Object.entries(controls)) ui.setFieldError(control, errors[key] ?? '');
      return errors;
    };
    const form = el('form', { id: formId, class: 'stack', novalidate: true }, [
      status,
      ui.field({ label: 'Value', control: value, hint: 'Sent in the token’s roles claim. Letters, digits, dots, underscores and hyphens, starting with a letter or digit.' }),
      ui.field({ label: 'Display name', control: displayName, hint: 'Shown in Entra ID when the role is assigned.' }),
      ui.field({ label: 'Description', control: description, hint: 'Shown in Entra ID next to the display name.' }),
    ]);
    for (const control of Object.values(controls)) control.addEventListener('blur', () => { if (control.value) check(); });
    const dialog = ui.modal({
      title: 'Create an app role', description: 'Adds an enabled role to the gateway’s app registration. It is not admitted to the gateway until you admit it in Access & models.',
      content: [form], actions: [cancel, submit],
    });
    cancel.addEventListener('click', () => dialog.close());
    value.focus();
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      status.replaceChildren();
      const errors = check();
      const first = Object.keys(errors)[0];
      if (first) { controls[first].focus(); return; }
      ui.busy(submit, true, 'Creating…');
      try {
        const result = await api.post('/api/roles', { value: value.value.trim(), displayName: displayName.value.trim(), description: description.value.trim() });
        created = result.role?.value ?? value.value.trim();
        ui.invalidate('/api/roles');
        dialog.close();
        ui.toast(`Created ${created}`);
        if (ctx.active()) render(ctx);
      } catch (err) {
        status.replaceChildren(ui.banner('error', err.message, { title: 'The role was not created' }));
        ui.busy(submit, false);
      }
    });
  }

  return { title: 'Roles', render };
})();
