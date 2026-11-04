// Per-role Claude Desktop settings for the admin file (T-122, P-40): validation and the policy's rendered desktop block.
// Claude Desktop's Chat, Cowork and Code switches, which the gateway serves in the policy's desktop block; Desktop applies
// bootstrap values over local settings and makes them read-only
// (https://claude.com/docs/third-party/claude-desktop/configuration#chattabenabled).
export const DESKTOP_SETTINGS = [
  'chatTabEnabled', 'coworkTabEnabled', 'isClaudeCodeForDesktopEnabled',
  'userPluginMarketplacesEnabled', 'userPluginUploadsEnabled', 'skillCreationEnabled', 'isDesktopExtensionEnabled',
];
const IMPORT_SETTINGS = ['enabled', 'exportEnabled'];

export function desktopErrors(policy, i) {
  const errors = policy.desktop !== undefined && typeof policy.desktop !== 'boolean' ? [`policies[${i}].desktop: must be true or false`] : [];
  const settings = policy.desktopSettings;
  if (settings === undefined) return errors;
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) return [...errors, `policies[${i}].desktopSettings: must be an object`];
  for (const [key, value] of Object.entries(settings)) {
    if (key === 'claudeAiImport') {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) errors.push(`policies[${i}].desktopSettings.claudeAiImport: must be an object`);
      else for (const [name, on] of Object.entries(value)) {
        if (!IMPORT_SETTINGS.includes(name)) errors.push(`policies[${i}].desktopSettings.claudeAiImport.${name}: not a supported import setting`);
        else if (typeof on !== 'boolean') errors.push(`policies[${i}].desktopSettings.claudeAiImport.${name}: must be true or false`);
      }
    } else if (!DESKTOP_SETTINGS.includes(key)) errors.push(`policies[${i}].desktopSettings.${key}: not a supported Claude Desktop setting (${DESKTOP_SETTINGS.join(', ')}, claudeAiImport)`);
    else if (typeof value !== 'boolean') errors.push(`policies[${i}].desktopSettings.${key}: must be true or false`);
  }
  return errors;
}

// The desktop block of a policy: the empty opt-in, or the opt-in with Desktop's switches in DESKTOP_SETTINGS order.
export const desktopBlock = (settings) => {
  const keys = DESKTOP_SETTINGS.filter((k) => typeof settings?.[k] === 'boolean');
  const imports = IMPORT_SETTINGS.filter((k) => typeof settings?.claudeAiImport?.[k] === 'boolean');
  return keys.length || imports.length ? [
    '      desktop:', ...keys.map((k) => `        ${k}: ${settings[k]}`),
    ...(imports.length ? ['        claudeAiImport:', ...imports.map((k) => `          ${k}: ${settings.claudeAiImport[k]}`)] : []),
  ] : ['      desktop: {}'];
};

// Whether a policy opts in to Claude Desktop: its own desktop wins; absent, deployment.desktop's default applies.
export const desktopOfFor = (deployment) => (p) => (p.desktop !== undefined ? p.desktop === true : deployment?.desktop === true);
