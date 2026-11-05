# MCP server

An MCP (Model Context Protocol) server that lets AI apps (Claude, Cursor, your own agents) use the society system **as a signed-in person**. Each person only sees the tools their role allows, and every tool call goes through the normal API, so the same permission checks, data scoping, emails and notifications apply as in the web app.

- **Endpoint:** `POST /mcp` (Streamable HTTP, stateless)
- **Login:** `Authorization: Bearer <token>`. Create a token in the app (menu → *Connect an AI app*) or with `POST /api/v1/auth/mcp-token`.
- **Tool count:** 58 tools in total. Society Admin: 46, Society Secretary: 44, Committee Member: 23, Accountant: 19, Resident: 26, Tenant: 14, Security Guard: 18, Maintenance Staff: 12, Super Admin: 6.
- An Admin or Secretary can switch AI access off for a particular person (Residents / Staff lists → *Hide chatbot*). That also blocks their token.

## Connect

```
claude mcp add --transport http society https://YOUR-API/mcp --header "Authorization: Bearer <token>"
```

For clients configured with JSON:

```json
{ "mcpServers": { "society": { "type": "http", "url": "https://YOUR-API/mcp", "headers": { "Authorization": "Bearer <token>" } } } }
```

## Safety

- A token can do everything its owner can. Treat it like a password; it expires (1–90 days).
- Tools that email residents, delete data or move money say so in their description, and the destructive ones require `confirm: true`.
- Left out on purpose: changing passwords, Stripe keys and AI keys, so a prompt can never touch credentials.
- The society is always taken from the signed-in user, never from anything the AI supplies.
- A renter (Tenant role) only gets the few tools their landlord has left switched on; the API enforces this on every call.

## Tools by role

✅ = the role is offered the tool. The API still decides what each call may actually do.

### Account

| Tool | What it does | Admin | Secretary | Committee | Accountant | Resident | Tenant | Security Guard | Maint. Staff | Super Admin |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `get_my_profile` | Who am I signed in as: name, email, role and the permissions that role has | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `get_dashboard_stats` | The home-screen numbers for my role: residents, open complaints, visitors today, collections (admins); my bills, complaints and passes (residents); my open jobs (staff) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |  |
| `get_my_notifications` | My latest in-app notifications (new charges, payments received, autopay problems) and how many are unread | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |  |
| `mark_notifications_read` ✏️ | Mark all of my notifications as read | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |  |

### Notices

| Tool | What it does | Admin | Secretary | Committee | Accountant | Resident | Tenant | Security Guard | Maint. Staff | Super Admin |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `list_notices` | Society announcements, newest first | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |  |
| `publish_notice` ✏️ | Publish an announcement on the notice board | ✅ | ✅ | ✅ |  |  |  |  |  |  |

### Society

| Tool | What it does | Admin | Secretary | Committee | Accountant | Resident | Tenant | Security Guard | Maint. Staff | Super Admin |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `get_society_structure` | The society with its buildings, wings and flats | ✅ | ✅ | ✅ |  |  |  | ✅ |  |  |
| `list_flats` | Every flat with its wing, building and current residents (name and phone) | ✅ | ✅ | ✅ |  |  |  | ✅ |  |  |
| `add_building` ✏️ | Add a new building to the society | ✅ | ✅ |  |  |  |  |  |  |  |
| `add_wing_with_flats` ✏️ | Create a wing and generate all its flats at once (numbered like A-101) | ✅ | ✅ |  |  |  |  |  |  |  |

### Residents

| Tool | What it does | Admin | Secretary | Committee | Accountant | Resident | Tenant | Security Guard | Maint. Staff | Super Admin |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `list_residents` | Residents with their flat, contact details and role | ✅ | ✅ | ✅ |  |  |  |  |  |  |
| `add_resident` ✏️ | Register a resident to a flat | ✅ | ✅ |  |  |  |  |  |  |  |
| `set_resident_role` ✏️ | Make a resident the Society Secretary, or turn them back into a regular resident | ✅ |  |  |  |  |  |  |  |  |

### Staff

| Tool | What it does | Admin | Secretary | Committee | Accountant | Resident | Tenant | Security Guard | Maint. Staff | Super Admin |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `list_staff` | Guards, supervisors, plumbers, electricians and cleaners | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |  |
| `add_staff_member` ✏️ | Onboard a guard, supervisor or service staff | ✅ | ✅ |  |  |  |  |  |  |  |
| `set_staff_active` ✏️ | Switch a staff member on or off | ✅ | ✅ |  |  |  |  |  |  |  |
| `set_staff_leave` ✏️ | Mark a staff member as on leave between two dates | ✅ | ✅ |  |  |  |  |  |  |  |
| `clear_staff_leave` ✏️ | Mark a staff member as back from leave | ✅ | ✅ |  |  |  |  |  |  |  |

### Tenancies

| Tool | What it does | Admin | Secretary | Committee | Accountant | Resident | Tenant | Security Guard | Maint. Staff | Super Admin |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `list_my_flats_for_rent` | The flats I own and whether each is currently rented out (activeTenancyId is empty when it is vacant) |  |  |  |  | ✅ |  |  |  |  |
| `list_tenancies` | Tenancies with the tenant, flat, rent, deposit, dates and status (ACTIVE or ENDED) | ✅ | ✅ | ✅ |  | ✅ |  |  |  |  |
| `get_tenancy_details` | A tenancy with every rent payment received and a month-by-month record of what was due, paid and outstanding | ✅ | ✅ | ✅ |  | ✅ |  |  |  |  |
| `rent_out_flat` ✏️ | Record a tenant for a flat | ✅ | ✅ |  |  | ✅ |  |  |  |  |
| `update_tenancy` ✏️ | Change the rent, deposit, agreement end date, notes, or what the tenant may do (visitor passes, complaints) | ✅ | ✅ |  |  | ✅ |  |  |  |  |
| `end_tenancy` ⚠️ | The tenant moves out: their login is closed straight away, their unused visitor passes stop working, and the tenancy is kept as rental history | ✅ | ✅ |  |  | ✅ |  |  |  |  |
| `record_rent_payment` ✏️ | Record rent the tenant paid the owner, against a month (YYYY-MM) | ✅ | ✅ |  |  | ✅ |  |  |  |  |

### Visitors

| Tool | What it does | Admin | Secretary | Committee | Accountant | Resident | Tenant | Security Guard | Maint. Staff | Super Admin |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `list_visitor_logs` | Gate entries newest first, with who they visited and when they came in and left | ✅ | ✅ | ✅ |  |  |  | ✅ |  |  |
| `create_visitor_pass` ✏️ | Create a QR visitor pass for my guest, cab or delivery |  |  |  |  | ✅ | ✅ |  |  |  |
| `list_my_visitor_passes` | The visitor passes I created, with their codes and validity |  |  |  |  | ✅ | ✅ |  |  |  |
| `cancel_visitor_pass` ⚠️ | Delete a visitor pass so it can no longer be used | ✅ | ✅ | ✅ |  | ✅ | ✅ |  |  |  |

### Gate

| Tool | What it does | Admin | Secretary | Committee | Accountant | Resident | Tenant | Security Guard | Maint. Staff | Super Admin |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `verify_visitor_pass` | Check a visitor’s pass code at the gate: is it valid, who is it for, which flat | ✅ | ✅ |  |  |  |  | ✅ |  |  |
| `check_in_visitor` ✏️ | Let a visitor with a valid pass in | ✅ | ✅ |  |  |  |  | ✅ |  |  |
| `log_walk_in_visitor` ✏️ | Check in someone without a pass (delivery rider, cab, unexpected guest) | ✅ | ✅ |  |  |  |  | ✅ |  |  |
| `check_out_visitor` ✏️ | Record that a visitor has left | ✅ | ✅ |  |  |  |  | ✅ |  |  |

### Complaints

| Tool | What it does | Admin | Secretary | Committee | Accountant | Resident | Tenant | Security Guard | Maint. Staff | Super Admin |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `list_complaints` | Complaint tickets with status, priority, who raised them, who is assigned and the update thread | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |  |
| `raise_complaint` ✏️ | File a complaint (any role can) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |  |
| `assign_complaint` ✏️ | Assign a complaint to a technician | ✅ | ✅ | ✅ |  |  |  |  |  |  |
| `update_complaint_status` ✏️ | Move a complaint to OPEN, IN_PROGRESS, RESOLVED or CLOSED | ✅ | ✅ | ✅ |  |  |  |  | ✅ |  |
| `escalate_complaint` ✏️ | Pass a complaint that is not being resolved to the Society Secretary or the Society Admin, who are notified | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |  |
| `comment_on_complaint` ✏️ | Add a progress note to a complaint | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |  |

### Billing

| Tool | What it does | Admin | Secretary | Committee | Accountant | Resident | Tenant | Security Guard | Maint. Staff | Super Admin |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `list_invoices` | Maintenance and function bills with amount, paid so far, due date and status | ✅ | ✅ | ✅ | ✅ | ✅ |  |  |  |  |
| `get_collection_summary` | Total billed, collected and outstanding across the society, with the collection percentage | ✅ | ✅ | ✅ | ✅ |  |  |  |  |  |
| `get_payment_options` | Whether the society accepts online payment (Stripe) and whether it is in test or live mode | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |  |
| `get_payment_link` ✏️ | Create a secure Stripe checkout link for one of my bills |  |  |  |  | ✅ |  |  |  |  |
| `get_autopay_status` | Whether autopay is on for me, and which card is saved |  |  |  |  | ✅ |  |  |  |  |
| `get_autopay_setup_link` ✏️ | Create a secure Stripe link where I can save a card for autopay |  |  |  |  | ✅ |  |  |  |  |
| `turn_off_autopay` ⚠️ | Turn autopay off and remove my saved card |  |  |  |  | ✅ |  |  |  |  |

### Charges

| Tool | What it does | Admin | Secretary | Committee | Accountant | Resident | Tenant | Security Guard | Maint. Staff | Super Admin |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `issue_charge` ✏️ | Charge every occupied flat (monthly maintenance, a function fee, or anything else) | ✅ | ✅ |  | ✅ |  |  |  |  |  |
| `list_charges` | Charges issued so far with how many flats have paid and how much has been collected | ✅ | ✅ |  | ✅ |  |  |  |  |  |
| `get_charge_details` | One charge with every flat’s invoice: resident names, amount paid and status | ✅ | ✅ |  | ✅ |  |  |  |  |  |
| `record_offline_payment` ✏️ | Record a payment received outside the app against one flat’s invoice | ✅ | ✅ |  | ✅ |  |  |  |  |  |
| `remind_unpaid_flats` ✏️ | Email and notify every resident whose flat has not paid this charge yet | ✅ | ✅ |  | ✅ |  |  |  |  |  |
| `cancel_charge` ⚠️ | Cancel a charge issued by mistake | ✅ | ✅ |  | ✅ |  |  |  |  |  |
| `get_stripe_connection_status` | Whether the society’s Stripe account is connected, in test or live mode, and whether the webhook is set up | ✅ |  |  |  |  |  |  |  |  |

### Platform

| Tool | What it does | Admin | Secretary | Committee | Accountant | Resident | Tenant | Security Guard | Maint. Staff | Super Admin |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `list_platform_data` | Platform-wide data |  |  |  |  |  |  |  |  | ✅ |
| `set_society_active` ✏️ | Suspend a society (everyone in it is locked out) or activate it again |  |  |  |  |  |  |  |  | ✅ |
| `delete_society` ⚠️ | Delete a society |  |  |  |  |  |  |  |  | ✅ |
| `delete_user` ⚠️ | Delete a user account |  |  |  |  |  |  |  |  | ✅ |
| `delete_staff_member` ⚠️ | Delete a staff member record |  |  |  |  |  |  |  |  | ✅ |

✏️ changes data · ⚠️ destructive (needs `confirm: true`)
