// The Help page's content (P-41, T-125): one entry per administrator task, with the steps in the console's own labels and
// the article that explains it. Plain data, loaded before help-page.js; tests/admin-ui-help.test.mjs checks that every
// label in `labels` appears in the console and every `doc` names an existing article and heading.
(() => {
  globalThis.helpTopics = [
    {
      id: 'departments', title: 'Create a department (business unit)',
      when: 'Group spend by team for chargeback. A department is the Department field of a user in Microsoft Entra ID.',
      steps: [
        'Open Chargeback, then the Business units card.',
        'Select Edit next to a developer, type a department name and a cost center, then Save. A new name creates the department.',
        'Repeat for each developer. Everyone with the same department name is one business unit.',
        'Editing needs the console\'s User.ReadWrite.All permission (Settings > Permissions). Without it, set the Department field in the Microsoft Entra admin center.',
      ],
      labels: ['Chargeback', 'Business units', 'Edit', 'Save'],
      doc: 'docs/learn/how-to-organize-departments.md#create-a-department-in-the-admin-console',
    },
    {
      id: 'groups', title: 'Give a whole team a role with an Entra group',
      when: 'Grant a gateway role to every member of a security group instead of one person at a time. Needs Microsoft Entra ID P1 or P2.',
      steps: [
        'Microsoft Entra admin center > Enterprise apps > the gateway\'s app > Users and groups > Add user/group.',
        'Select the group and the role, for example Gateway.Standard, then Assign.',
        'Members of the group get the role at their next sign-in. Members of groups inside that group do not: nested groups are not supported.',
        'Developers lists the group as one row. Chargeback still lists each member, because spend is recorded per user.',
      ],
      labels: ['Developers', 'Chargeback'],
      doc: 'docs/learn/how-to-organize-departments.md#give-a-whole-team-a-role-with-an-entra-group',
    },
    {
      id: 'admins', title: 'Give another person access to this console',
      when: 'Only accounts with the AdminUi.Admin app role can open the console.',
      steps: [
        'Microsoft Entra admin center > Enterprise apps > the app whose name ends in -admin-ui-signin > Users and groups > Add user/group.',
        'Select the person and the role AdminUi.Admin, then Assign. They sign out and in again.',
      ],
      labels: ['AdminUi.Admin'],
      doc: 'docs/learn/how-to-use-admin-console.md#open-the-console',
    },
    {
      id: 'onboard-one', title: 'Set up one developer machine',
      when: 'A single developer, without device management.',
      steps: [
        'Grant the developer a role on Developers > Grant a role.',
        'Settings > Client onboarding: choose the model, then Download client kit. Give the developer the developer folder from the zip.',
        'The developer installs Claude Code (winget install Anthropic.ClaudeCode), then follows START-HERE.txt in that folder.',
      ],
      labels: ['Developers', 'Grant a role', 'Client onboarding', 'Download client kit'],
      doc: 'docs/learn/tutorial-first-install.md#one-machine',
    },
    {
      id: 'onboard-intune', title: 'Set up many machines with Intune',
      when: 'Every developer machine is managed by Microsoft Intune.',
      steps: [
        'Settings > Client onboarding: Download client kit.',
        'Extract the zip on a Windows machine. In that folder, run powershell -ExecutionPolicy Bypass -File .\\New-IntunePackage.ps1 -PolicyFolder . -ToolPath <IntuneWinAppUtil.exe> to build the two .intunewin files.',
        'In the Intune admin center, add each as a Windows app (Win32) with the values in INTUNE.txt: first Claude Code, then the gateway profile, which depends on it.',
        'Assign both to the developers\' group. Each developer then runs sign-in.cmd once.',
      ],
      labels: ['Client onboarding', 'Download client kit'],
      doc: 'docs/learn/tutorial-first-install.md#many-machines-with-intune',
    },
    {
      id: 'desktop', title: 'Connect Claude Desktop',
      when: 'Developers use Claude Desktop, including Cowork, through the gateway.',
      steps: [
        'Access & models: turn on Claude Desktop for the role, then Review changes and Apply and roll out.',
        'Settings > Client onboarding: download ClaudeDesktop-HKLM.reg for one machine, or Set-ClaudeDesktopPolicy.ps1 for Intune.',
        'Intune: Devices > Scripts and remediations > Platform scripts, with "Run script in 64-bit PowerShell host" set to Yes. DESKTOP.txt in the kit lists every setting.',
        'The developer quits and reopens Claude Desktop, then signs in with the code it shows.',
      ],
      labels: ['Access & models', 'Claude Desktop', 'Review changes', 'Apply and roll out', 'Client onboarding'],
      doc: 'docs/learn/tutorial-first-install.md#claude-desktop',
    },
    {
      id: 'models', title: 'Change which models a role may use',
      when: 'Add a Foundry deployment, or allow or remove a model for a role.',
      steps: [
        'Access & models: Add model for a new Foundry deployment, or tick and untick a model in a role\'s row.',
        'Review changes shows the difference; Apply and roll out starts a new gateway revision and waits for its health check.',
      ],
      labels: ['Access & models', 'Add model', 'Review changes', 'Apply and roll out'],
      doc: 'docs/learn/how-to-admin-configure.md#change-models-and-per-role-model-access',
    },
    {
      id: 'caps', title: 'Set a spend cap',
      when: 'Limit what a person, a role or the whole organization spends per day, week or month.',
      steps: [
        'Budgets > Set cap: choose the scope (User, Role or the organization), the amount in USD and the period.',
        'The gateway enforces it at once. A developer over the cap gets HTTP 429 with the time the period resets.',
      ],
      labels: ['Budgets', 'Set cap'],
      doc: 'docs/learn/how-to-manage-users-and-groups.md#set-or-change-a-budget',
    },
    {
      id: 'chargeback', title: 'Report spend by department',
      when: 'Give finance the spend per business unit.',
      steps: [
        'Chargeback: choose the Period and Group by Department, Cost center or Role.',
        'Select a row to see its users, then Export CSV.',
        'Amounts are the gateway\'s list-price estimates for the period, not the Azure invoice.',
      ],
      labels: ['Chargeback', 'Period', 'Group by', 'Export CSV'],
      doc: 'docs/learn/how-to-organize-departments.md#check-the-result',
    },
  ];
})();
