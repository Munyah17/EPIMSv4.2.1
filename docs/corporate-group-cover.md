# Corporate & Group Insurance — Design

## The idea

Domestic cover insures **one person + their dependants**. Cover scopes
insure an **organisation's roster** instead:

| Scope | Who | Roster called |
|---|---|---|
| Corporate | A company / organisation | **Employees** |
| Group | Church, union, sports club, society | **Members** |
| Team | A squad, work crew or activity-bound group | **Team members** |

`Policy.onceOff` is a separate lifecycle flag, not a scope. A once-off
package keeps the organisation/team scope while switching billing to a
single negotiated start→end term — a school tour or event is the intended
case.

The organisation is the **policyholder** — it is billed for its roster,
never as a person itself. Recurring group billing stays per-head; once-off
packages bill each selected participant once for the package term.

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
  Corporate · Group · Teams · Once-off Package). Group scopes hide the
  dependants UI and show the roster checklist; once-off packages add an
  explicit end date plus negotiated package-level and participant-level
  premium/sum-assured terms.
- **Policies table**: group policies carry a `Corporate`/`Group`/`Team`
  pill; packages show as `Once-off Package` and archive at term end.
- **Policy document**: covered employees/members/participants table and
  package documents print Commencement/Expiration dates, never a monthly
  renewal date.

## Data model (migration `database/add_group_cover.sql`)

```
groups          group_members                 policies
─────────────   ───────────────────────────   ──────────────────────────
id              id                            + group_id    → groups
name            group_id → groups             + cover_scope  individual /
group_type      full_name                                   corporate /
reg number      national_id                                 group / team
contact_*       dob, phone, position,                       + team_activity
address         member_no, status                           + once_off
active          (removed = soft delete,
                 claims history preserved)
```

Removed members keep `status='removed'` rather than being deleted, so
historic claims remain traceable.

## Once-off packages

`database/add_once_off_packages.sql` adds `policies.once_off`, constrains
it to organisation-scoped finite terms, and replaces the recurring
one-live-policy-per-product guard with a term-scoped package guard. A
package:

- is created through New Policy → Once-off Package;
- requires an organisation and selected roster participants;
- uses negotiated package terms, with optional participant overrides;
- is active immediately and has no `nextPaymentDate`;
- is excluded from reminders, lapse notices and monthly group invoices;
- moves to `expired` after `endDate`; Restore reopens Edit so staff can
  set the new term.
