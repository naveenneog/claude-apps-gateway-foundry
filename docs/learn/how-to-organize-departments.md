---
title: Group developers into departments and teams
description: Tag developers with a department, cost center, company, office and division for chargeback in the admin console or from a CSV file, give a whole team a gateway role through an Entra group, and check the result in Chargeback.
author: naveenneog
ms.date: 10/27/2026
ms.topic: how-to
---
# Group developers into departments and teams

The admin console reports gateway spend per department on its **Chargeback** page. A department, called a
*business unit* in the console, is a tag the console keeps for each person in the gateway's own database, the table
`admin_console.user_tags`. Each person has five tags: **Department**, **Cost center**, **Company**, **Office** and
**Division** (admin-ui/server/user-tags.mjs:7-13). Everyone with the same department name is one business unit, and
**Group by** reports spend by any of the five, or by gateway role (admin-ui/server/chargeback.mjs:59). Tags are kept
by the person's Entra object ID, so a changed e-mail address keeps them. Entra ID is not changed: the console reads
Entra only for names, and it does not need the Graph permission `User.ReadWrite.All`, which can change every user in
the tenant (docs/adr/0015-business-unit-tags-in-the-gateway-database.md:1).

Tags need the managed database option, the default of a first install
([choose the database](how-to-install-stage-by-stage.md#choose-the-database)). On a gateway that keeps its database
inside its own app, the **Business units** card says so, and **Group by** **Gateway role** still works
(admin-ui/server/user-tags.mjs:18).

The screenshots on this page come from the console running on made-up data: Contoso, its people and its
departments are examples.

| Task | Where | Needs |
|---|---|---|
| Tag a few people | Admin console, **Chargeback** > **Business units** > **Edit** | The `AdminUi.Admin` role in the console |
| Tag many people | Admin console, **Chargeback** > **Business units** > **Import CSV** | The `AdminUi.Admin` role in the console |
| Give a whole team a role | Microsoft Entra admin center, the gateway's enterprise application | Microsoft Entra ID P1 or P2; Application Administrator or Cloud Application Administrator |

## Create a department in the admin console

1. Open the console and select **Chargeback**. The **Business units** card lists every person who holds a gateway
   role, with or without spend (admin-ui/server/chargeback.mjs:112).
1. Select **Edit** on a person's row, type the department name and, as needed, the cost center, company, office and
   division, and select **Save**. A department name that no one has yet creates a new business unit; the field also
   offers the names that exist.
1. Repeat for each person.

![The Business units card: four units, one person without a unit, the Import CSV button, and the row of Drew Kim being edited with the department Platform Engineering, the cost center CC-1001, the company Contoso and the office Seattle.](media/admin-console-business-units.png)

Each value is 1 to 64 characters without control characters; an emptied field clears the tag
(admin-ui/server/user-tags.mjs:16). The new value shows as soon as **Save** completes.

## Import tags for many users from a CSV file

**Import CSV** on the **Business units** card reads a file with a header row and one row per person. The `user`
column names the person by user principal name, e-mail address or Entra object ID; the other columns are
`department`, `costCenter`, `company`, `office` and `division`, in any order and any subset
(admin-ui/server/user-tags.mjs:24-29). `tags.csv`:

```output
user,department,costCenter,company,office,division
avery.chen@contoso.com,Platform Engineering,CC-1001,Contoso,Pune,R&D
sam.rivera@contoso.com,Data Science,CC-2040,,,
morgan.lee@contoso.com,Mobile Apps,,,,
```

An empty cell leaves that tag as it is; a tag is cleared in the console with **Edit**. The console reports how many
people it updated and, for each line it skipped, the reason, such as a person who is not in the directory or a value
over 64 characters; the other lines are still imported (admin-ui/server/user-tags.mjs:149-172). A file has at most
5,000 rows.
## Give a whole team a role with an Entra group

Instead of granting a role to one person at a time on the console's **Developers** page, an administrator can
assign the role to a security group. Every member of the group then holds the role
([assign users and groups](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/assign-user-or-group-access-portal)).

1. Create the group, or use an existing one: **Entra ID** > **Groups** > **New group**, type **Security**, with the
   team as members ([manage groups](https://learn.microsoft.com/en-us/entra/fundamentals/how-to-manage-groups)).
1. **Entra ID** > **Enterprise apps** > **All applications** > the gateway's application (for a first install,
   `claude-apps-gateway-eval`) > **Users and groups** > **Add user/group**.
1. Select the group and a role, such as `Gateway.Standard`, then **Assign**. The gateway's roles allow users and
   groups (infra/azure-test/entra-app.json:20).

Limits of a group assignment:

- It needs Microsoft Entra ID P1 or P2. Without either, the **Groups** option is not offered and roles are granted
  one person at a time (docs/UNKNOWNS.md, U-24).
- Nested groups are not supported: members of a group inside the assigned group do not get the role
  ([assign users and groups](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/assign-user-or-group-access-portal)).
- A member gets the role at their next sign-in to the gateway, because the role travels in the sign-in token.
- This project's test tenant assigns people directly, so the group path is documented by Microsoft but not tested
  here (docs/UNKNOWNS.md, U-110).

The console lists the group itself as one row on **Developers**. **Remove** on that row answers
`no user <group id> in the directory` and changes nothing; a group's assignment is removed in the Entra admin
center, on the same **Users and groups** page.

![The Developers page: eight people and the group sg-claude-mobile-apps, each with its role.](media/admin-console-developers-group.png)

The **Business units** card lists people, not groups, and names the groups it leaves out. The members' tags are set
with a CSV file, as in the section above, which accepts any user in the directory. **Chargeback** still reports each
member who has spend, because the gateway records spend per person and the report finds each person by e-mail
address (admin-ui/server/chargeback.mjs:33).

## Check the result

1. **Chargeback** > **Group by** **Department**, or **Cost center**, **Company**, **Office** or **Division**, for the
   **Period** to report.
1. Each value shows its share of the total and its spend. Select a row to list its people; people without that tag
   appear as **No department** (or **No cost center**, and so on).
1. **Export CSV** downloads the same report for finance, one row per person with the columns period, group, name,
   email, roles, department, cost_center, company, office, division, spend_usd, cap_usd and resolved
   (admin-ui/server/chargeback.mjs:96).

![The By department card: Data Science, Platform Engineering, Security, Mobile Apps and No department, each with its share and spend.](media/admin-console-chargeback-by-department.png)

Amounts are the gateway's list-price estimates for the period, not the Azure invoice
([Use the admin console](how-to-use-admin-console.md)). The console's **Help** page repeats these steps.

![The Help page with the topic "Create a department (business unit)" open.](media/admin-console-help.png)

## Related content

- [Manage users, groups and budgets](how-to-manage-users-and-groups.md)
- [Use the admin console](how-to-use-admin-console.md)
- [Glossary](glossary.md)