// The Settings page: who is signed in (GET /api/me), what admin-ui is allowed to do (GET /api/capabilities: each
// permission, what it unlocks and how to grant it) and which gateway it manages (GET /api/gateway-config).
const settingsPage = (() => {
  const DESCRIPTION = 'What admin-ui is allowed to do, and how to grant what is missing.';

  async function render(ctx) {
    const refresh = ui.button('Check again', { kind: 'secondary', iconName: 'refresh', onclick: () => {
      ui.invalidate('/api/capabilities');
      ui.invalidate('/api/me');
      render(ctx);
    } });
    ctx.root.replaceChildren(ui.pageHeader({ title: 'Settings', description: DESCRIPTION, actions: [refresh] }),
      el('div', { class: 'grid-2' }, [ui.skeleton('block'), ui.skeleton('block')]), ui.skeleton('table', 6), ui.loading('Checking permissions'));
    const [me, caps, config, signIn] = await Promise.all([ui.settle(ui.shared('/api/me')), ui.settle(ui.shared('/api/capabilities')), ui.settle(ui.shared('/api/gateway-config')),
      ui.settle(api.get('/api/sign-in-credential'))]);
    if (!ctx.active()) return;
    ctx.root.replaceChildren(
      ui.pageHeader({ title: 'Settings', description: DESCRIPTION, actions: [refresh] }),
      el('div', { class: 'grid-2' }, [identityCard(me), gatewayCard(config)]),
      signInCard(ctx, signIn),
      permissionsCard(caps),
      onboardingCard(config));
  }

  function identityCard(me) {
    if (me instanceof Error) return ui.card({ title: 'Signed in', content: ui.banner('error', `Could not read the sign-in state: ${me.message}`) });
    const id = settingsView.identity(me);
    if (id.mode === 'off') {
      return ui.card({ title: 'Sign-in', content: [
        ui.banner('warning', ['Changes that need a signed-in admin are unavailable: the gateway configuration, roles and user attributes. Spend caps and developer roles can still be changed.'], { title: id.text }),
      ] });
    }
    return ui.card({ title: 'Signed in', content: el('div', { class: 'card-body' }, [
      el('div', { class: 'person' }, [
        el('span', { class: 'avatar lg', 'aria-hidden': 'true', text: id.initials }),
        el('div', { class: 'who' }, [el('strong', { text: id.title }), id.subtitle && el('span', { text: id.subtitle })]),
      ]),
      el('dl', { class: 'facts' }, [
        el('dt', { text: 'Sign-in' }), el('dd', { text: 'Required' }),
        el('dt', { text: 'admin-ui role' }), el('dd', {}, [id.admin ? ui.pill('AdminUi.Admin', 'ok') : ui.pill('No admin role: read-only', 'warn')]),
      ]),
    ]) });
  }

  function gatewayCard(config) {
    if (config instanceof Error) return ui.card({ title: 'Gateway', content: ui.banner('info', `The gateway configuration is not available: ${config.message}`) });
    const row = (label, value) => [el('dt', { text: label }), el('dd', {}, [value])];
    return ui.card({ title: 'Gateway', content: el('div', { class: 'card-body' }, [el('dl', { class: 'facts' }, [
      ...row('Container app', el('code', { text: config.gateway?.app ?? 'unknown' })),
      ...row('Latest revision', el('code', { text: config.gateway?.revision ?? 'unknown' })),
      ...row('Topology', config.topology === 'private' ? 'Private network' : config.topology === 'test' ? 'Test (public)' : String(config.topology ?? 'unknown')),
      ...row('Admin file', el('code', { text: config.adminFilePath ?? 'unknown' })),
      ...row('Client URL', el('code', { text: config.gateway?.url ?? 'Not available' })),
      ...row('Database', config.restart?.temporaryDatabase ? ui.pill('Temporary storage: reset by each new revision', 'warn') : ui.pill('Persistent', 'ok')),
    ])]) });
  }

  // ADR-0016: how the gateway signs in to Microsoft Entra, when that credential ends, and Renew now.
  function signInCard(ctx, status) {
    if (status instanceof Error) {
      return ui.card({ title: 'Gateway sign-in credential', content: ui.banner('info', `Not available here: ${status.message}`) });
    }
    const view = settingsView.signIn(status);
    const months = el('select', { name: 'signin-months', 'aria-label': 'Validity of the new certificate, in months' },
      Array.from({ length: 24 }, (_, i) => el('option', { value: String(i + 1), text: `${i + 1} month${i ? 's' : ''}`, selected: i + 1 === (status.defaults?.months ?? 12) })));
    const renew = ui.button('Renew now', { kind: 'secondary', iconName: 'refresh', onclick: async () => {
      const ok = await ui.confirm({ title: 'Renew the gateway sign-in credential now?', confirmText: 'Renew now',
        body: ['A new credential is registered next to the current one, a new gateway revision starts with it, and the old one is removed once that revision is ready. Signed-in developers stay signed in.'] });
      if (!ok) return;
      ui.busy(renew, true, 'Starting');
      try {
        await api.post('/api/sign-in-credential/renew', status.mode === 'certificate' ? { months: Number(months.value) } : {});
        ui.toast('Renewal started. It takes a few minutes; Check again shows the result.');
        render(ctx);
      } catch (err) {
        ui.toast(`Could not start the renewal: ${err.message}`, 'error');
      } finally { ui.busy(renew, false); }
    } });
    const row = (label, value) => [el('dt', { text: label }), el('dd', {}, [value])];
    return ui.card({ title: 'Gateway sign-in credential', description: 'What the gateway signs in to Microsoft Entra ID with.', content: el('div', { class: 'card-body stack' }, [
      el('dl', { class: 'facts' }, [
        ...row('Type', view.modeText),
        ...row('Identifier', el('code', { text: status.credentialId ?? 'unknown' })),
        ...row('Ends', ui.pill(view.endsText, view.kind)),
      ]),
      el('p', { text: view.note }),
      view.lastRunText && ui.banner(status.lastRun?.state === 'failed' ? 'error' : 'info', [view.lastRunText]),
      el('div', { class: 'kit-files' }, [status.mode === 'certificate' ? el('label', { class: 'field' }, [el('span', { text: 'New certificate valid for' }), months]) : null, renew]),
    ]) });
  }
  // P-41: every client file new-client-policy.mjs writes, for this gateway and a model of its admin file.
  function clientKitSection(config) {
    const models = Array.isArray(config?.admin?.models) ? config.admin.models.map((m) => m.id).filter(Boolean) : [];
    if (!models.length) return [ui.banner('info', 'The client kit needs the gateway configuration, which is not available here.')];
    const select = el('select', { name: 'kit-model', 'aria-label': 'Model the developer profile starts with' }, models.map((id) => el('option', { value: id, text: id })));
    const links = el('div', { class: 'stack' });
    const draw = () => {
      const kit = settingsView.clientKit(config.topology, select.value);
      // fetch, not a plain link: a refusal (for example a model the admin file no longer lists) is shown as a message,
      // rather than saved as a file of JSON.
      const fetchFile = async (btn, href) => {
        ui.busy(btn, true, 'Preparing');
        try {
          const res = await fetch(href, { credentials: 'same-origin' });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error ?? `HTTP ${res.status}`);
          }
          const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'client-file';
          ui.download(name, await res.blob(), res.headers.get('Content-Type') ?? 'application/octet-stream');
        } catch (err) {
          ui.toast(`Could not download: ${err.message}`, 'error');
        } finally {
          ui.busy(btn, false);
        }
      };
      const link = (href, text, kind) => {
        const btn = ui.button(text, { kind, iconName: 'download' });
        btn.addEventListener('click', () => fetchFile(btn, href));
        return btn;
      };
      links.replaceChildren(...(kit ? [
        el('div', { class: 'kit-files' }, [link(kit.zip, 'Download client kit (.zip)', 'primary')]),
        el('div', { class: 'kit-files' }, kit.files.map((f) => link(f.href, f.label, 'secondary'))),
      ] : []));
    };
    select.addEventListener('change', draw);
    draw();
    return [
      el('h3', { text: 'Client kit' }),
      el('p', { text: 'The same files as node scripts\\admin\\new-client-policy.mjs, for this gateway: developer\\ for one machine, intune\\ for Intune (INTUNE.txt lists every field), desktop\\ for Claude Desktop (DESKTOP.txt), and login\\ for the network-restricted gateway only. Choose a model every developer\'s role allows.' }),
      el('label', { class: 'field' }, [el('span', { text: 'Model' }), select]),
      links,
    ];
  }

  function onboardingCard(config) {
    const plan = settingsView.onboarding(config?.topology, config?.gateway?.url);
    const managed = plan.managedSettings;
    const claudeCode = plan.claudeCode === 'profile'
      ? [
        el('h3', { text: 'Claude Code: the gateway profile' }),
        ui.banner('info', [plan.reason]),
        el('p', { text: 'Give each developer the developer folder of the client kit above, or deploy the intune folder to many machines as two Win32 apps (Claude Code, then the profile). On the developer machine, in the developer folder:' }),
        plan.profileCommand
          ? el('pre', { class: 'code-block' }, [el('code', { text: `${plan.profileCommand}\n` })])
          : ui.banner('warning', 'The gateway URL is not available from the Container App ingress. Ask the gateway administrator for the client URL.'),
        el('p', { text: 'The command opens a browser for Microsoft Entra sign-in, then claude-gateway.cmd in the profile folder starts Claude Code through the gateway.' }),
        el('p', { text: 'The launcher also runs in the VS Code integrated terminal (Terminal > New Terminal).' }),
      ]
      : [
        el('h3', { text: 'Claude Code and VS Code: managed login' }),
        el('p', { text: 'Download managed-settings.json and distribute it as machine-managed settings through Intune, Group Policy or another device-management tool. It forces gateway sign-in and merges with other managed settings. The user then signs in with the gateway account.' }),
        managed
          ? el('div', { class: 'stack' }, [
            el('pre', { class: 'code-block' }, [el('code', { text: `${JSON.stringify(managed, null, 2)}\n` })]),
            ui.button('Download managed-settings.json', { kind: 'secondary', iconName: 'download', onclick: () => ui.download('managed-settings.json', `${JSON.stringify(managed, null, 2)}\n`) }),
          ])
          : ui.banner('warning', 'The gateway URL is not available from the Container App ingress. Ask the gateway administrator for the client URL before creating managed settings.'),
        el('p', { text: 'No separate onboarding.json is required. The downloaded managed-settings.json is the Claude Code/VS Code policy; Desktop/Cowork uses the bootstrapUrl policy.' }),
      ];
    const steps = [
      el('p', { text: 'Give each developer a gateway role on the Access & models page. The role decides the models and whether Claude Desktop/Cowork is available.' }),
      ...clientKitSection(config),
      ...claudeCode,
      el('p', { text: 'The VS Code extension side panel includes its own Claude Code command-line tool; whether it reuses a CLI gateway sign-in has not been verified.' }),
      el('h3', { text: 'Claude Desktop and Cowork' }),
      el('p', { text: `These clients use a separate machine policy: HKLM\\SOFTWARE\\Policies\\Claude\\bootstrapUrl set to ${plan.desktopBootstrapUrl ?? '<gateway-url>/user/bootstrap'}. Import ClaudeDesktop-HKLM.reg on one machine, or run Set-ClaudeDesktopPolicy.ps1 as an Intune platform script in the 64-bit PowerShell host. Desktop sign-in is separate; the assigned gateway role must include Desktop access.` }),
      el('p', { text: 'Step-by-step guide, Intune included: the Help page, or docs/learn/tutorial-first-install.md in the gateway repository, section "Onboard developers".' }),
      el('a', { href: 'https://code.claude.com/docs/en/claude-apps-gateway', target: '_blank', rel: 'noopener', class: 'inline-link', text: 'Claude apps gateway client documentation' }),
    ];
    return ui.card({
      title: 'Client onboarding',
      description: 'Client settings and access requirements for a developer joining this gateway.',
      content: el('details', { class: 'onboarding' }, [
        el('summary', { text: 'Show client onboarding steps' }),
        el('div', { class: 'onboarding-body stack' }, steps),
      ]),
    });
  }

  function permissionsCard(caps) {
    if (caps instanceof Error) return ui.card({ title: 'Permissions', content: ui.banner('error', `Could not check permissions: ${caps.message}`) });
    const list = settingsView.checklist(caps);
    const meter = el('span', { class: 'meter-fill' });
    meter.style.setProperty('--pct', `${list.total ? Math.round((list.granted / list.total) * 100) : 0}%`);
    return ui.card({
      title: 'Permissions', className: 'flush',
      description: `${list.granted} of ${list.total} granted. Each missing one names what it unlocks and how to grant it.`,
      actions: [el('span', { class: 'meter wide', role: 'img', 'aria-label': `${list.granted} of ${list.total} permissions granted` }, [meter])],
      content: [
        list.problems.length ? el('div', { class: 'card-body' }, [ui.banner('warning', list.problems, { title: 'Some checks could not run' })]) : null,
        el('ul', { class: 'checklist' }, list.items.map((item) => el('li', { class: item.granted ? 'granted' : 'missing' }, [
          el('span', { class: 'check-icon', 'aria-hidden': 'true' }, [ui.icon(item.granted ? 'check' : 'x', 14)]),
          el('div', { class: 'check-main' }, [
            el('div', { class: 'check-title' }, [el('strong', { text: item.label }), ui.pill(item.status, item.granted ? 'ok' : 'danger'), el('code', { class: 'check-key', text: item.key })]),
            item.unlocks && el('p', { text: item.unlocks }),
            item.howToGrant && (item.granted
              ? el('details', { class: 'how' }, [el('summary', { text: 'How it is granted' }), el('p', { class: 'how-text', text: item.howToGrant })])
              : el('div', { class: 'how open' }, [el('span', { class: 'how-label', text: 'How to grant' }), el('p', { class: 'how-text', text: item.howToGrant })])),
          ]),
        ]))),
      ],
    });
  }

  return { title: 'Settings', render };
})();
