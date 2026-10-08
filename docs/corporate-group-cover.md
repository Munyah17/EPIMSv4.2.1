# Corporate & Group Insurance — Design

## The idea

Domestic cover insures **one person + their dependants**. Two new cover
scopes insure an **organisation's roster** instead:

| Scope | Who | Roster called |
|---|---|---|
| Corporate | A company / organisation | **Employees** |
| Group | Church, union, sports club, society | **Members** |

The organisation is the **policyholder** — it is billed for its roster,
never as a person itself. Billing stays per-head: `premium × members`.

## Flow

```
Register Organisation          Build Roster              Issue Policy
┌──────────────────┐    ┌──────────────────────┐    ┌───────────────────────┐
│ Groups page      │    │ Org → Manage Roster   │    │ New Policy            │
│ + Add Group      │───▶│ + member: name,       │───▶│ Cover scope:          │
│ name, type       │    │ national ID, DOB,     │    │ ● Corporate / Group   │
│ (company/church/ │    │ phone, position       │    │ pick org + tick who   │
│ union/sports…)   │    │ (soft-remove only)    │    │ is covered            │
│ contact person   │    └──────────────────────┘    └───────────┬───────────┘
└──────────────────┘                                             │
                                                                 ▼
Policy issued: org = holder, members ride        ┌───────────────────────┐
on the policy like dependants used to  ────────▶ │ Billed: rate × N      │
Policy document: "EMPLOYEES / MEMBERS            │ members (org is not   │
COVERED" section replaces DEPENDANTS             │ a billed head)        │
                                                 └───────────────────────┘
```

## Why it reuses the dependants machinery

A covered employee/member is stored in the same shape as a dependant
(`relationship: 'Employee'` / `'Member'`). That means payments,
reminders, claims, receipts and the policy PDF all keep working with no
parallel payment rail — the only change is that on group policies the
billing engine counts **members only** (the organisation holder isn't a
billable head), and the document/labels say EMPLOYEES or MEMBERS.

## What staff see

- **Groups** nav item (under Clients): org list — name, type pill,
  contact, member count — plus roster management.
- **New Policy modal**: Cover scope switch (Individual/Family ·
  Corporate · Group). Group scopes hide the dependants UI and show the
  member checklist with running premium total.
- **Policies table**: group policies carry a `Corporate`/`Group` pill
  with the organisation name.
- **Policy document**: covered employees/members table.

## Data model (migration `database/add_group_cover.sql`)

```
groups          group_members                 policies
─────────────   ───────────────────────────   ──────────────────────────
id              id                            + group_id    → groups
name            group_id → groups             + cover_scope  individual /
group_type      full_name                                   corporate /
reg number      national_id                                 group
contact_*       dob, phone, position,
address         member_no, status
active          (removed = soft delete,
                 claims history preserved)
```

Removed members keep `status='removed'` rather than being deleted, so
historic claims remain traceable.
