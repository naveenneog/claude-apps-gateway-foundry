// Pure helpers for the signed-in identity in the shell (GET /api/me) and the Settings page's permission checklist
// (GET /api/capabilities, admin-ui/server/capabilities.mjs). Loaded before app.js as a classic script;
// tests/admin-ui-web.test.mjs loads it in node:vm.
(() => {
  const list = (value) => (Array.isArray(value) ? value : []);

  const settingsView = {
    managedSettings(gatewayUrl) {
      try {
        const url = new URL(gatewayUrl);
        if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
        return { forceLoginMethod: 'gateway', forceLoginGatewayUrl: url.origin, parentSettingsBehavior: 'merge' };
      } catch {
        return null;
      }
    },

    // Claude Code's /login accepts only a gateway whose host name resolves to private addresses
    // (https://code.claude.com/docs/en/claude-apps-gateway#prerequisites), so managed login applies to the private
    // topology; the public test gateway uses the developer profile, which signs in without /login (ADR-0004).
    onboarding(topology, gatewayUrl) {
      const managed = this.managedSettings(gatewayUrl);
      const origin = managed?.forceLoginGatewayUrl ?? null;
      const desktopBootstrapUrl = origin ? `${origin}/user/bootstrap` : null;
      if (topology === 'private') return { claudeCode: 'managed', managedSettings: managed, profileCommand: null, reason: null, desktopBootstrapUrl };
      return {
        claudeCode: 'profile', managedSettings: null, desktopBootstrapUrl,
        profileCommand: origin ? `powershell -NoProfile -ExecutionPolicy Bypass -File .\\Install-ClaudeGatewayProfile.ps1 -GatewayUrl ${origin} -FastModel <model the role allows> -Model <model the role allows>` : null,
        reason: 'This gateway has a public address. Claude Code\'s /login accepts only a gateway on private addresses, so a forced-login policy would block every sign-in; developers use the gateway profile instead.',
      };
    },

    // P-41: GET /api/client-kit links for one model of the admin file. The forced-login files apply only to the private
    // topology, for the reason onboarding() gives; the Desktop policy applies to both.
    clientKit(topology, model) {
      if (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(model)) return null;
      const base = `/api/client-kit?model=${encodeURIComponent(model)}&fastModel=${encodeURIComponent(model)}`;
      const file = (path, label) => ({ label, href: `${base}&file=${encodeURIComponent(path)}` });
      const files = [
        file('desktop/ClaudeDesktop-HKLM.reg', 'ClaudeDesktop-HKLM.reg'),
        file('desktop/Set-ClaudeDesktopPolicy.ps1', 'Set-ClaudeDesktopPolicy.ps1 (Intune)'),
        file('desktop/DESKTOP.txt', 'DESKTOP.txt'),
        file('intune/INTUNE.txt', 'INTUNE.txt'),
      ];
      if (topology === 'private') files.unshift(file('login/managed-settings.json', 'managed-settings.json'), file('login/ClaudeCode-HKLM.reg', 'ClaudeCode-HKLM.reg'));
      return { zip: base, files };
    },

    identity(me) {
      if (!me) return { mode: 'unknown', title: 'Sign-in state unknown', subtitle: '', text: 'Sign-in state unknown', initials: '?', admin: false, badge: '' };
      if (me.signIn === 'off') {
        return { mode: 'off', title: 'Sign-in is off', subtitle: 'Access is limited by IP address', text: 'Sign-in is off — access is limited by IP address', initials: '', admin: false, badge: '' };
      }
      if (!me.user) return { mode: 'anonymous', title: 'Not signed in', subtitle: '', text: 'Not signed in', initials: '?', admin: false, badge: '' };
      const name = String(me.user.name ?? '').trim();
      const upn = String(me.user.upn ?? '').trim();
      const title = name || upn || 'Signed in';
      const letters = name ? name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]) : [title[0]];
      const admin = me.isAdmin === true;
      return {
        mode: 'user', title, subtitle: name ? upn : '', text: name && upn ? `${name} (${upn})` : title,
        initials: letters.join('').toUpperCase(), admin, badge: admin ? 'Admin' : 'No access',
      };
    },

    // ADR-0011: with sign-in on, the API refuses everyone without AdminUi.Admin, so the shell shows this instead of a page.
    accessDenied(me) {
      if (!me || me.signIn !== 'required' || me.isAdmin === true) return { denied: false };
      const account = String(me.user?.upn ?? me.user?.name ?? '').trim() || 'This account';
      const roles = list(me.roles).map(String).filter(Boolean);
      return {
        denied: true,
        title: 'No access to this console',
        body: [
          `${account} is signed in, but this console is for administrators only. It needs the AdminUi.Admin app role on the admin-ui sign-in app.`,
          'An administrator assigns it in Entra admin center > Enterprise applications > the "-admin-ui-signin" app > Users and groups > Add user/group, with the role AdminUi.Admin. Sign out and in again afterwards so the new role is in the token.',
          roles.length ? `Roles this sign-in carries: ${roles.join(', ')}.` : 'This sign-in carries no app roles.',
        ],
      };
    },

    // ADR-0016: GET /api/sign-in-credential as the Sign-in credential card shows it.
    signIn(status) {
      const modeText = status?.mode === 'certificate' ? 'Certificate (self-signed, no client secret)' : status?.mode === 'secret' ? 'Client secret' : 'Unknown';
      const days = typeof status?.daysLeft === 'number' ? status.daysLeft : null;
      const kind = days === null ? 'warn' : days < 0 ? 'danger' : days < (status?.renewsWithinDays ?? 30) ? 'warn' : 'ok';
      const endsText = status?.endsAt ? `${String(status.endsAt).slice(0, 10)}${days === null ? '' : ` (${days} days)`}` : 'Not known';
      const note = `The daily job job-signin-renewer renews it ${status?.renewsWithinDays ?? 30} days before it ends, with no sign-in interruption. Renew now does the same at once.`;
      const run = status?.lastRun;
      const lastRunText = run ? `Renew now: ${run.state}${run.finishedAt ? ` at ${String(run.finishedAt).slice(0, 16).replace('T', ' ')} UTC` : ' (started; a new gateway revision takes a few minutes)'}` : null;
      return { modeText, kind, endsText, note, lastRunText };
    },
    checklist(capabilities) {
      const items = list(capabilities?.items).map((item) => ({
        key: item.key, label: item.label, granted: item.granted === true, status: item.granted === true ? 'Granted' : 'Missing',
        unlocks: item.unlocks ?? '', howToGrant: item.howToGrant ?? '',
      }));
      return { granted: items.filter((i) => i.granted).length, total: items.length, items, problems: list(capabilities?.problems).map(String) };
    },
  };

  globalThis.settingsView = settingsView;
})();
