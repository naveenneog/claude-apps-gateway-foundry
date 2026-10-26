// Pure helpers for the Roles page: the gateway application's Entra app roles from GET /api/roles, and the checks a
// new role's value, display name and description pass before POST /api/roles (admin-ui/server/roles.mjs keeps the
// same rules and stays the authority). Loaded before app.js as a classic script; tests/admin-ui-web.test.mjs loads it.
(() => {
  // Graph allows a value of up to 120 characters (https://learn.microsoft.com/graph/api/resources/approle, read
  // 2026-10-24); the gateway's role pattern (scripts/admin/new-gateway-config.mjs) narrows the characters.
  const VALUE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  const TEXT_MAX = 256;
  const list = (value) => (Array.isArray(value) ? value : []);

  function textError(value, what) {
    const text = String(value ?? '').trim();
    if (!text) return `Enter ${what}.`;
    if (text.length > TEXT_MAX) return `Use at most ${TEXT_MAX} characters.`;
    if (/[\x00-\x1f\x7f]/.test(text)) return 'Remove control characters.';
    return null;
  }

  const rolesView = {
    valueError(value, roles) {
      const text = String(value ?? '').trim();
      if (!text) return 'Enter a value, for example Gateway.Trial.';
      if (text.length > 120) return 'Use at most 120 characters.';
      if (!/^[A-Za-z0-9]/.test(text)) return 'The value must start with a letter or digit.';
      if (!VALUE.test(text)) return 'Use only letters, digits, dots, underscores and hyphens.';
      const existing = list(roles).find((r) => String(r.value).toLowerCase() === text.toLowerCase());
      if (existing) return `${existing.value} already exists; values are compared without regard to case.`;
      return null;
    },

    formErrors(form, roles) {
      const errors = {};
      const value = rolesView.valueError(form?.value, roles);
      const displayName = textError(form?.displayName, 'a display name');
      const description = textError(form?.description, 'a description');
      if (value) errors.value = value;
      if (displayName) errors.displayName = displayName;
      if (description) errors.description = description;
      return errors;
    },

    admittedValues(response) {
      return list(response?.roles).filter((r) => r.admitted === true).map((r) => r.value);
    },

    // The role options where a role is chosen (Developers, a Budgets role cap): the admitted roles from Entra, else the
    // admin file's roles, else null for a free-text field.
    choices(response, admin) {
      if (Array.isArray(response?.roles)) return response.roles.filter((r) => r.admitted === true).map((r) => ({ value: r.value, label: r.displayName || '' }));
      if (Array.isArray(admin?.roles)) return admin.roles.map((value) => ({ value, label: '' }));
      return null;
    },

    // admin: the admin file, when readable, for deployment.desktop (a policy without desktop inherits it) and for
    // telling "no policies, so every model" from a missing policy.
    roleRows(response, admin) {
      const noPolicies = Boolean(admin) && !Array.isArray(admin.policies);
      return list(response?.roles).map((r) => {
        const admitted = r.admitted === true;
        let models = '—';
        let desktop = '—';
        if (admitted && r.policy) {
          models = list(r.policy.models).join(', ') || 'None';
          const on = r.policy.desktop === null || r.policy.desktop === undefined ? admin?.deployment?.desktop === true : r.policy.desktop === true;
          desktop = on ? 'Allowed' : 'Not allowed';
        } else if (admitted && noPolicies) {
          models = 'All models';
          desktop = 'Not allowed';
        }
        return {
          id: r.id, value: r.value, displayName: r.displayName || '', description: r.description || '',
          enabled: r.isEnabled !== false, admitted, models, desktop,
        };
      });
    },

    createBlocker(response, capabilities) {
      if (response?.canCreate !== false) return null;
      const signIn = capabilities?.signIn;
      if (signIn?.mode === 'off') return 'Sign-in is off. Creating a role needs admin sign-in with the AdminUi.Admin role.';
      if (signIn && signIn.isAdmin === false) return 'Your account does not hold the AdminUi.Admin role, which creating a role needs.';
      if (capabilities?.graph && capabilities.graph.writeOwnedApps === false) {
        return "admin-ui cannot change the gateway's app registration. It needs Application.ReadWrite.OwnedBy and to be an owner of that app registration.";
      }
      return 'The server does not allow creating roles from admin-ui.';
    },
  };

  globalThis.rolesView = rolesView;
})();
