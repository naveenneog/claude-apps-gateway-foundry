// Per-role Claude Desktop settings for the admin file (T-122, P-40): validation and the policy's rendered desktop block.
// Claude Desktop's Chat, Cowork and Code switches, which the gateway serves in the policy's desktop block; Desktop applies
// bootstrap values over local settings and makes them read-only
// (https://claude.com/docs/third-party/claude-desktop/configuration#chattabenabled).
export const DESKTOP_SETTINGS = ['chatTabEnabled', 'coworkTabEnabled', 'isClaudeCodeForDesktopEnabled'];

export function desktopErrors(policy, i) {
  const errors = policy.desktop !== undefined && typeof policy.desktop !== 'boolean' ? [`policies[${i}].desktop: must be true or false`] : [];
  const settings = policy.desktopSettings;
  if (settings === undefined) return errors;
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) return [...errors, `policies[${i}].desktopSettings: must be an object`];
  for (const [key, value] of Object.entries(settings)) {
    if (!DESKTOP_SETTINGS.includes(key)) errors.push(`policies[${i}].desktopSettings.${key}: not a supported Claude Desktop setting (${DESKTOP_SETTINGS.join(', ')})`);
    else if (typeof value !== 'boolean') errors.push(`policies[${i}].desktopSettings.${key}: must be true or false`);
  }
  return errors;
}

// The desktop block of a policy: the empty opt-in, or the opt-in with Desktop's switches in DESKTOP_SETTINGS order.
export const desktopBlock = (settings) => {
  const keys = DESKTOP_SETTINGS.filter((k) => typeof settings?.[k] === 'boolean');
  return keys.length ? ['      desktop:', ...keys.map((k) => `        ${k}: ${settings[k]}`)] : ['      desktop: {}'];
};

// Whether a policy opts in to Claude Desktop: its own desktop wins; absent, deployment.desktop's default applies.
export const desktopOfFor = (deployment) => (p) => (p.desktop !== undefined ? p.desktop === true : deployment?.desktop === true);
