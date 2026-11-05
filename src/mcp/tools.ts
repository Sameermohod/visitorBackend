import { strongPassword } from '../middleware/security';
import { z } from 'zod';

/**
 * Every tool the MCP server can offer. Each one is a thin wrapper around an existing REST endpoint,
 * called with the signed-in user's own token, so the API's permission checks, data scoping and
 * side effects (emails, notifications) apply exactly as they do in the web app.
 * `access` only decides which tools a person SEES; the API still enforces what they may DO.
 */

export interface Caller {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  tenantId: string | null;
  permissions: Set<string>;
}

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  group: string;
  input?: z.ZodRawShape;
  access: (c: Caller) => boolean;
  readOnly?: boolean;
  /** Irreversible or far-reaching: the model must pass confirm=true after asking the user. */
  destructive?: boolean;
  request?: (args: any, c: Caller) => HttpRequest;
  /** For tools that need no API call */
  local?: (args: any, c: Caller) => unknown;
}

/* ---------------- access helpers ---------------- */

const isSuper = (c: Caller) => c.role === 'Super Admin';
const tenantUser = (c: Caller) => !isSuper(c);
const can = (...codes: string[]) => (c: Caller) => tenantUser(c) && codes.some((code) => c.permissions.has(code));
const roleIs = (...roles: string[]) => (c: Caller) => roles.includes(c.role);
const adminRoles = ['Society Admin', 'Society Secretary', 'Committee Member'];

const confirm = z.literal(true).describe('Must be true. Ask the user to confirm this action first.');
const uuid = (what: string) => z.string().uuid().describe(what);
const limit = z.number().int().min(1).max(200).optional().describe('Maximum number of rows to return (default 50).');
const visitorType = z.enum(['GUEST', 'DELIVERY', 'CAB', 'SERVICE_PROVIDER']);

export const TOOLS: ToolDef[] = [
  /* ===== Everyone ===== */
  {
    name: 'get_my_profile', title: 'My profile', group: 'Account', readOnly: true,
    description: 'Who am I signed in as: name, email, role and the permissions that role has.',
    access: () => true,
    local: (_a, c) => ({ id: c.id, name: `${c.firstName} ${c.lastName}`, email: c.email, role: c.role, tenantId: c.tenantId, permissions: [...c.permissions].sort() }),
  },
  {
    name: 'get_dashboard_stats', title: 'Dashboard numbers', group: 'Account', readOnly: true,
    description: 'The home-screen numbers for my role: residents, open complaints, visitors today, collections (admins); my bills, complaints and passes (residents); my open jobs (staff).',
    access: tenantUser,
    request: () => ({ method: 'GET', path: '/analytics/dashboard' }),
  },
  {
    name: 'get_my_notifications', title: 'My notifications', group: 'Account', readOnly: true,
    description: 'My latest in-app notifications (new charges, payments received, autopay problems) and how many are unread.',
    access: tenantUser,
    request: () => ({ method: 'GET', path: '/notifications' }),
  },
  {
    name: 'mark_notifications_read', title: 'Mark notifications read', group: 'Account',
    description: 'Mark all of my notifications as read.',
    access: tenantUser,
    request: () => ({ method: 'POST', path: '/notifications/read-all' }),
  },

  /* ===== Notices ===== */
  {
    name: 'list_notices', title: 'Notice board', group: 'Notices', readOnly: true,
    description: 'Society announcements, newest first.',
    input: { limit },
    access: can('residents:view', 'complaints:view', 'billing:view', 'visitors:view', 'notices:manage'),
    request: (a) => ({ method: 'GET', path: '/notices', query: { limit: a.limit } }),
  },
  {
    name: 'publish_notice', title: 'Publish a notice', group: 'Notices',
    description: 'Publish an announcement on the notice board. EVERY resident is emailed, so confirm the wording with the user before calling.',
    input: {
      title: z.string().min(3).max(150),
      content: z.string().min(10).describe('The full message, at least 10 characters.'),
      category: z.enum(['GENERAL', 'MAINTENANCE', 'EVENT']).default('GENERAL'),
    },
    access: can('notices:manage'),
    request: (a) => ({ method: 'POST', path: '/notices', body: a }),
  },

  /* ===== Society structure ===== */
  {
    name: 'get_society_structure', title: 'Society layout', group: 'Society', readOnly: true,
    description: 'The society with its buildings, wings and flats. Includes the society id and building ids needed to add wings.',
    access: can('residents:view', 'society:manage', 'visitors:gate'),
    request: () => ({ method: 'GET', path: '/society' }),
  },
  {
    name: 'list_flats', title: 'Flats and who lives there', group: 'Society', readOnly: true,
    description: 'Every flat with its wing, building and current residents (name and phone). Use it to find a flat id.',
    input: { limit },
    access: can('residents:view', 'visitors:gate'),
    request: (a) => ({ method: 'GET', path: '/society/flats', query: { limit: a.limit ?? 200 } }),
  },
  {
    name: 'add_building', title: 'Add a building', group: 'Society',
    description: 'Add a new building to the society.',
    input: { societyId: uuid('Society id from get_society_structure'), name: z.string().min(1).max(50), wingsCount: z.number().int().min(1).default(1) },
    access: can('society:manage'),
    request: (a) => ({ method: 'POST', path: '/society/buildings', body: a }),
  },
  {
    name: 'add_wing_with_flats', title: 'Add a wing and create its flats', group: 'Society',
    description: 'Create a wing and generate all its flats at once (numbered like A-101). Flats per floor and floors decide how many are made.',
    input: {
      buildingId: uuid('Building id from get_society_structure'),
      wingName: z.string().min(1).max(50),
      floorsCount: z.number().int().min(1).max(60),
      flatsPerFloor: z.number().int().min(1).max(20),
      flatType: z.enum(['1BHK', '2BHK', '3BHK', '4BHK']).default('2BHK'),
    },
    access: can('society:manage'),
    request: (a) => ({ method: 'POST', path: '/society/flats/batch', body: a }),
  },

  /* ===== Residents ===== */
  {
    name: 'list_residents', title: 'Residents directory', group: 'Residents', readOnly: true,
    description: 'Residents with their flat, contact details and role. Use q to search by name, email or flat number.',
    input: { q: z.string().optional().describe('Search text'), limit },
    access: can('residents:view'),
    request: (a) => ({ method: 'GET', path: '/residents/directory', query: { q: a.q, limit: a.limit ?? 50 } }),
  },
  {
    name: 'add_resident', title: 'Add a resident', group: 'Residents',
    description: 'Register a resident to a flat. A login is created and the temporary password is emailed to them (they must change it at first sign-in). Only the Society Admin may set societyRole to Society Secretary.',
    input: {
      firstName: z.string().min(1), lastName: z.string().min(1), email: z.string().email(),
      phoneNumber: z.string().min(10), flatId: uuid('Flat id from list_flats'),
      ownershipStatus: z.enum(['OWNER', 'TENANT']),
      password: strongPassword.optional().describe('Temporary password. Leave out for the default.'),
      societyRole: z.enum(['Resident', 'Society Secretary']).optional(),
    },
    access: can('residents:manage'),
    request: (a) => ({ method: 'POST', path: '/residents/onboard', body: a }),
  },
  {
    name: 'set_resident_role', title: 'Appoint or remove the Society Secretary', group: 'Residents',
    description: 'Make a resident the Society Secretary, or turn them back into a regular resident. Admin only.',
    input: { residentId: uuid('Resident id from list_residents'), role: z.enum(['Resident', 'Society Secretary']) },
    access: can('users:edit'),
    request: (a) => ({ method: 'PATCH', path: `/residents/${a.residentId}/role`, body: { role: a.role } }),
  },

  /* ===== Staff ===== */
  {
    name: 'list_staff', title: 'Staff and guards', group: 'Staff', readOnly: true,
    description: 'Guards, supervisors, plumbers, electricians and cleaners. Each has a status: AVAILABLE, BUSY (with activeJobs and queued counts) or ON_LEAVE (with the return date). Check it before assigning a complaint. Managers also see shift, salary and login details.',
    input: { limit },
    access: can('staff:manage', 'complaints:create'),
    request: (a) => ({ method: 'GET', path: '/staff/directory', query: { limit: a.limit ?? 100 } }),
  },
  {
    name: 'add_staff_member', title: 'Add a staff member', group: 'Staff',
    description: 'Onboard a guard, supervisor or service staff. If a login email is given, a temporary password is emailed and they must change it at first sign-in. Guards and supervisors need an email.',
    input: {
      firstName: z.string().min(1), lastName: z.string().min(1), phoneNumber: z.string().min(10),
      type: z.enum(['Guard', 'Supervisor', 'Plumber', 'Electrician', 'Cleaner']),
      email: z.string().email().optional(),
      password: strongPassword.optional().describe('Temporary password. Leave out for the default.'),
      shiftStart: z.string().default('08:00'), shiftEnd: z.string().default('20:00'),
      salaryMonthly: z.number().min(0).optional(),
    },
    access: can('staff:manage'),
    request: (a) => ({ method: 'POST', path: '/staff/onboard', body: a }),
  },
  {
    name: 'set_staff_active', title: 'Activate or deactivate staff', group: 'Staff',
    description: 'Switch a staff member on or off.',
    input: { staffId: uuid('Staff id from list_staff'), isActive: z.boolean() },
    access: can('staff:manage'),
    request: (a) => ({ method: 'PATCH', path: `/staff/${a.staffId}/status`, body: { isActive: a.isActive } }),
  },

  /* ===== Renting out a flat ===== */
  {
    name: 'list_my_flats_for_rent', title: 'Flats I own', group: 'Tenancies', readOnly: true,
    description: 'The flats I own and whether each is currently rented out (activeTenancyId is empty when it is vacant). Flat owners only.',
    access: roleIs('Resident'),
    request: () => ({ method: 'GET', path: '/tenancies/my-flats' }),
  },
  {
    name: 'list_tenancies', title: 'Tenancies and rental history', group: 'Tenancies', readOnly: true,
    description: 'Tenancies with the tenant, flat, rent, deposit, dates and status (ACTIVE or ENDED). Owners see their own flats; the society office sees every flat. Ended tenancies are the rental history.',
    input: { status: z.enum(['ACTIVE', 'ENDED']).optional() },
    access: (c) => c.role === 'Resident' || can('residents:view')(c),
    request: (a) => ({ method: 'GET', path: '/tenancies', query: { status: a.status } }),
  },
  {
    name: 'get_tenancy_details', title: 'One tenancy with its rent record', group: 'Tenancies', readOnly: true,
    description: 'A tenancy with every rent payment received and a month-by-month record of what was due, paid and outstanding.',
    input: { tenancyId: uuid('Tenancy id from list_tenancies') },
    access: (c) => c.role === 'Resident' || can('residents:view')(c),
    request: (a) => ({ method: 'GET', path: `/tenancies/${a.tenancyId}` }),
  },
  {
    name: 'rent_out_flat', title: 'Rent out a flat', group: 'Tenancies',
    description: 'Record a tenant for a flat. Creates a limited tenant login (visitor passes, complaints and notices only, never society bills) and emails them a temporary password. An owner can rent out their own flat; the Admin or Secretary can do it for any flat. Confirm the details with the user first.',
    input: {
      flatId: uuid('Flat id (from list_my_flats_for_rent or list_flats)'),
      firstName: z.string().min(1), lastName: z.string().min(1), email: z.string().email(), phoneNumber: z.string().min(10),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('YYYY-MM-DD'),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Agreement end date, YYYY-MM-DD'),
      monthlyRent: z.number().min(0), securityDeposit: z.number().min(0).default(0), notes: z.string().max(1000).optional(),
      allowVisitorPasses: z.boolean().default(true), allowComplaints: z.boolean().default(true),
      password: strongPassword.optional().describe('Temporary password. Leave out for the default.'),
    },
    access: (c) => c.role === 'Resident' || can('residents:manage')(c),
    request: (a) => {
      const { allowVisitorPasses, allowComplaints, ...rest } = a;
      return { method: 'POST', path: '/tenancies', body: { ...rest, access: { visitors: allowVisitorPasses, complaints: allowComplaints } } };
    },
  },
  {
    name: 'update_tenancy', title: 'Change a tenancy', group: 'Tenancies',
    description: 'Change the rent, deposit, agreement end date, notes, or what the tenant may do (visitor passes, complaints). Only for an ACTIVE tenancy.',
    input: {
      tenancyId: uuid('Tenancy id'), monthlyRent: z.number().min(0).optional(), securityDeposit: z.number().min(0).optional(),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), notes: z.string().max(1000).nullable().optional(),
      allowVisitorPasses: z.boolean().optional(), allowComplaints: z.boolean().optional(),
    },
    access: (c) => c.role === 'Resident' || can('residents:manage')(c),
    request: (a) => {
      const { tenancyId, allowVisitorPasses, allowComplaints, ...rest } = a;
      // The API replaces the whole access setting, so send both switches; the model should pass both when it changes one
      const access = allowVisitorPasses !== undefined && allowComplaints !== undefined ? { visitors: allowVisitorPasses, complaints: allowComplaints } : undefined;
      return { method: 'PATCH', path: `/tenancies/${tenancyId}`, body: { ...rest, ...(access ? { access } : {}) } };
    },
  },
  {
    name: 'end_tenancy', title: 'End a tenancy (tenant moves out)', group: 'Tenancies', destructive: true,
    description: 'The tenant moves out: their login is closed straight away, their unused visitor passes stop working, and the tenancy is kept as rental history.',
    input: {
      tenancyId: uuid('Tenancy id'), endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Move-out date (default today)'),
      reason: z.string().max(500).optional(), depositReturned: z.boolean().optional(), confirm,
    },
    access: (c) => c.role === 'Resident' || can('residents:manage')(c),
    request: (a) => ({ method: 'POST', path: `/tenancies/${a.tenancyId}/end`, body: { endDate: a.endDate, reason: a.reason, depositReturned: a.depositReturned } }),
  },
  {
    name: 'record_rent_payment', title: 'Record rent received', group: 'Tenancies',
    description: 'Record rent the tenant paid the owner, against a month (YYYY-MM). This is the owner’s own rent record, not the society’s maintenance bills.',
    input: {
      tenancyId: uuid('Tenancy id'), month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).describe('The month it is for, YYYY-MM'),
      amount: z.number().positive(), method: z.enum(['CASH', 'BANK_TRANSFER', 'UPI', 'CHEQUE', 'OTHER']),
      paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), reference: z.string().max(100).optional(), note: z.string().max(300).optional(),
    },
    access: (c) => c.role === 'Resident' || can('residents:manage')(c),
    request: (a) => ({ method: 'POST', path: `/tenancies/${a.tenancyId}/payments`, body: { month: a.month, amount: a.amount, method: a.method, paidOn: a.paidOn, reference: a.reference, note: a.note } }),
  },

  /* ===== Staff leave ===== */
  {
    name: 'set_staff_leave', title: 'Mark staff on leave', group: 'Staff',
    description: 'Mark a staff member as on leave between two dates. They cannot be given complaints while away. Complaints they already hold are reported so they can be reassigned.',
    input: { staffId: uuid('Staff id from list_staff'), until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Last day of leave, YYYY-MM-DD'), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('First day (default today)'), reason: z.string().max(200).optional() },
    access: can('staff:manage'),
    request: (a) => ({ method: 'PUT', path: `/staff/${a.staffId}/leave`, body: { from: a.from, until: a.until, reason: a.reason } }),
  },
  {
    name: 'clear_staff_leave', title: 'Staff back from leave', group: 'Staff',
    description: 'Mark a staff member as back from leave.',
    input: { staffId: uuid('Staff id') },
    access: can('staff:manage'),
    request: (a) => ({ method: 'DELETE', path: `/staff/${a.staffId}/leave` }),
  },

  /* ===== Visitors ===== */
  {
    name: 'list_visitor_logs', title: 'Visitor log', group: 'Visitors', readOnly: true,
    description: 'Gate entries newest first, with who they visited and when they came in and left. checkedOutAt empty means still inside.',
    input: { limit },
    access: can('visitors:view'),
    request: (a) => ({ method: 'GET', path: '/visitors/logs', query: { limit: a.limit ?? 50 } }),
  },
  {
    name: 'create_visitor_pass', title: 'Pre-approve a visitor', group: 'Visitors',
    description: 'Create a QR visitor pass for my guest, cab or delivery. Returns the pass code to share. Residents only.',
    input: {
      name: z.string().min(1), phoneNumber: z.string().min(10), visitorType: visitorType.default('GUEST'),
      vehicleNumber: z.string().optional(), company: z.string().optional(), purpose: z.string().optional(),
      validForDays: z.number().int().min(1).max(90).default(1).describe('How many days the pass works (1 = one visit today).'),
    },
    access: roleIs('Resident', 'Tenant'),
    request: (a) => {
      const now = Date.now();
      const { validForDays, ...rest } = a;
      return { method: 'POST', path: '/visitors/pre-approve', body: { ...rest, validFrom: new Date(now).toISOString(), validUntil: new Date(now + validForDays * 86400000).toISOString() } };
    },
  },
  {
    name: 'list_my_visitor_passes', title: 'My visitor passes', group: 'Visitors', readOnly: true,
    description: 'The visitor passes I created, with their codes and validity.',
    access: roleIs('Resident', 'Tenant'),
    request: () => ({ method: 'GET', path: '/visitors/my-approvals' }),
  },
  {
    name: 'cancel_visitor_pass', title: 'Cancel a visitor pass', group: 'Visitors', destructive: true,
    description: 'Delete a visitor pass so it can no longer be used. Residents can cancel their own passes.',
    input: { passId: uuid('Pass id from list_my_visitor_passes'), confirm },
    access: can('visitors:create'),
    request: (a) => ({ method: 'DELETE', path: `/visitors/${a.passId}` }),
  },
  {
    name: 'verify_visitor_pass', title: 'Verify a pass code', group: 'Gate', readOnly: true,
    description: 'Check a visitor’s pass code at the gate: is it valid, who is it for, which flat.',
    input: { passCode: z.string().min(3).describe('Code like PASS-AB12-X9Y8') },
    access: can('visitors:gate'),
    request: (a) => ({ method: 'GET', path: '/visitors/verify-pass', query: { qrCode: a.passCode } }),
  },
  {
    name: 'check_in_visitor', title: 'Check in a pre-approved visitor', group: 'Gate',
    description: 'Let a visitor with a valid pass in. Also emails the flat’s residents.',
    input: { visitorId: uuid('Visitor id from verify_visitor_pass'), flatId: z.string().uuid().optional(), notes: z.string().optional() },
    access: can('visitors:gate'),
    request: (a) => ({ method: 'POST', path: '/visitors/check-in', body: a }),
  },
  {
    name: 'log_walk_in_visitor', title: 'Log a walk-in or delivery', group: 'Gate',
    description: 'Check in someone without a pass (delivery rider, cab, unexpected guest). Only do this after the flat’s resident has agreed by phone. Emails the flat’s residents.',
    input: {
      name: z.string().min(1), phoneNumber: z.string().min(10), visitorType: z.enum(['GUEST', 'DELIVERY', 'CAB']),
      flatId: uuid('Occupied flat id from list_flats'), company: z.string().optional(), vehicleNumber: z.string().optional(),
      purpose: z.string().optional(), notes: z.string().optional(),
    },
    access: can('visitors:gate'),
    request: (a) => ({ method: 'POST', path: '/visitors/manual-entry', body: a }),
  },
  {
    name: 'check_out_visitor', title: 'Check out a visitor', group: 'Gate',
    description: 'Record that a visitor has left.',
    input: { logId: uuid('Log id from list_visitor_logs') },
    access: can('visitors:gate'),
    request: (a) => ({ method: 'POST', path: `/visitors/check-out/${a.logId}` }),
  },

  /* ===== Complaints ===== */
  {
    name: 'list_complaints', title: 'Complaints', group: 'Complaints', readOnly: true,
    description: 'Complaint tickets with status, priority, who raised them, who is assigned and the update thread. Residents only see their own.',
    input: { status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']).optional(), limit },
    access: can('complaints:view'),
    request: (a) => ({ method: 'GET', path: '/complaints', query: { status: a.status, limit: a.limit ?? 50 } }),
  },
  {
    name: 'raise_complaint', title: 'Raise a complaint', group: 'Complaints',
    description: 'File a complaint (any role can). The category is worked out automatically and the deadline is set from the priority. If you pick a technician who is BUSY the call is refused with code STAFF_BUSY: ask the user whether to add it to the queue (queue=true) or to call the technician; if they are ON_LEAVE pick someone else.',
    input: {
      title: z.string().min(3).max(150), description: z.string().min(10),
      priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
      staffId: z.string().uuid().optional().describe('Optionally send straight to this technician (from list_staff).'),
      queue: z.boolean().optional().describe('true = join the technician\x27s queue if they are busy.'),
    },
    access: can('complaints:create'),
    request: (a) => ({ method: 'POST', path: '/complaints/raise', body: a }),
  },
  {
    name: 'assign_complaint', title: 'Assign a complaint', group: 'Complaints',
    description: 'Assign a complaint to a technician. Check their status in list_staff first: a BUSY technician needs queue=true (the complaint waits in their queue and starts automatically when they finish a job), and one ON_LEAVE cannot be assigned. The raiser and the technician are notified.',
    input: { complaintId: uuid('Complaint id from list_complaints'), staffId: uuid('Staff id from list_staff'), queue: z.boolean().optional().describe('true = add to the queue when the technician is busy.') },
    access: (c) => can('complaints:resolve')(c) && adminRoles.includes(c.role),
    request: (a) => ({ method: 'POST', path: `/complaints/${a.complaintId}/assign`, body: { staffId: a.staffId, queue: a.queue } }),
  },
  {
    name: 'update_complaint_status', title: 'Update complaint status', group: 'Complaints',
    description: 'Move a complaint to OPEN, IN_PROGRESS, RESOLVED or CLOSED. The resident is emailed.',
    input: { complaintId: uuid('Complaint id'), status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']) },
    access: can('complaints:resolve'),
    request: (a) => ({ method: 'PATCH', path: `/complaints/${a.complaintId}/status`, body: { status: a.status } }),
  },
  {
    name: 'escalate_complaint', title: 'Escalate a complaint', group: 'Complaints',
    description: 'Pass a complaint that is not being resolved to the Society Secretary or the Society Admin, who are notified. The person who raised it can do this once the deadline (overdue) has passed; the assigned technician and the society office can do it any time. Tell the user what will happen first.',
    input: { complaintId: uuid('Complaint id'), to: z.enum(['Society Secretary', 'Society Admin']), note: z.string().max(500).optional().describe('Why it needs attention.') },
    access: can('complaints:view'),
    request: (a) => ({ method: 'POST', path: `/complaints/${a.complaintId}/escalate`, body: { to: a.to, note: a.note } }),
  },
  {
    name: 'comment_on_complaint', title: 'Add a complaint update', group: 'Complaints',
    description: 'Add a progress note to a complaint. The other party is emailed.',
    input: { complaintId: uuid('Complaint id'), comment: z.string().min(1) },
    access: can('complaints:view'),
    request: (a) => ({ method: 'POST', path: `/complaints/${a.complaintId}/comments`, body: { comment: a.comment } }),
  },

  /* ===== Bills ===== */
  {
    name: 'list_invoices', title: 'Bills', group: 'Billing', readOnly: true,
    description: 'Maintenance and function bills with amount, paid so far, due date and status. Residents only see their own flat’s bills.',
    input: { status: z.enum(['UNPAID', 'PARTIALLY_PAID', 'PAID', 'OVERDUE']).optional(), limit },
    access: can('billing:view'),
    request: (a) => ({ method: 'GET', path: '/billing/invoices', query: { status: a.status, limit: a.limit ?? 50 } }),
  },
  {
    name: 'get_collection_summary', title: 'Collection summary', group: 'Billing', readOnly: true,
    description: 'Total billed, collected and outstanding across the society, with the collection percentage.',
    access: (c) => can('billing:view')(c) && c.role !== 'Resident',
    request: () => ({ method: 'GET', path: '/billing/ledger' }),
  },
  {
    name: 'get_payment_options', title: 'Can I pay online?', group: 'Billing', readOnly: true,
    description: 'Whether the society accepts online payment (Stripe) and whether it is in test or live mode.',
    access: tenantUser,
    request: () => ({ method: 'GET', path: '/payments/config' }),
  },
  {
    name: 'get_payment_link', title: 'Get a link to pay a bill', group: 'Billing',
    description: 'Create a secure Stripe checkout link for one of my bills. Give the user the url to open (or scan). Residents only, own flat only.',
    input: { invoiceId: uuid('Invoice id from list_invoices') },
    access: (c) => c.role === 'Resident' && c.permissions.has('billing:pay'),
    request: (a) => ({ method: 'POST', path: '/payments/checkout', body: { invoiceId: a.invoiceId } }),
  },
  {
    name: 'get_autopay_status', title: 'Autopay status', group: 'Billing', readOnly: true,
    description: 'Whether autopay is on for me, and which card is saved.',
    access: roleIs('Resident'),
    request: () => ({ method: 'GET', path: '/payments/autopay' }),
  },
  {
    name: 'get_autopay_setup_link', title: 'Link to turn on autopay', group: 'Billing',
    description: 'Create a secure Stripe link where I can save a card for autopay. Give the user the url to open.',
    access: roleIs('Resident'),
    request: () => ({ method: 'POST', path: '/payments/autopay/setup' }),
  },
  {
    name: 'turn_off_autopay', title: 'Turn off autopay', group: 'Billing', destructive: true,
    description: 'Turn autopay off and remove my saved card.',
    input: { confirm },
    access: roleIs('Resident'),
    request: () => ({ method: 'DELETE', path: '/payments/autopay' }),
  },

  /* ===== Charges (maintenance & functions) ===== */
  {
    name: 'issue_charge', title: 'Issue a maintenance or function charge', group: 'Charges',
    description: 'Charge every occupied flat (monthly maintenance, a function fee, or anything else). EVERY resident gets an email and an in-app notification, so confirm the title, amount and due date with the user first.',
    input: {
      title: z.string().min(3).max(150),
      kind: z.enum(['MAINTENANCE', 'FUNCTION', 'OTHER']).default('MAINTENANCE'),
      amount: z.number().positive().describe('Amount per flat in rupees, before GST.'),
      gstRate: z.number().min(0).max(100).default(0),
      dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('YYYY-MM-DD'),
      description: z.string().max(1000).optional(),
    },
    access: can('charges:manage'),
    request: (a) => ({ method: 'POST', path: '/charges', body: a }),
  },
  {
    name: 'list_charges', title: 'Issued charges', group: 'Charges', readOnly: true,
    description: 'Charges issued so far with how many flats have paid and how much has been collected.',
    access: can('charges:manage'),
    request: () => ({ method: 'GET', path: '/charges' }),
  },
  {
    name: 'get_charge_details', title: 'Who has paid a charge', group: 'Charges', readOnly: true,
    description: 'One charge with every flat’s invoice: resident names, amount paid and status. Invoice ids here are used to record payments.',
    input: { chargeId: uuid('Charge id from list_charges') },
    access: can('charges:manage'),
    request: (a) => ({ method: 'GET', path: `/charges/${a.chargeId}` }),
  },
  {
    name: 'record_offline_payment', title: 'Record a cash/cheque/bank payment', group: 'Charges',
    description: 'Record a payment received outside the app against one flat’s invoice. Amount defaults to the full balance.',
    input: {
      invoiceId: uuid('Invoice id from get_charge_details'),
      method: z.enum(['CASH', 'CHEQUE', 'BANK_TRANSFER', 'UPI']),
      amount: z.number().positive().optional(), reference: z.string().max(100).optional(),
    },
    access: can('charges:manage'),
    request: (a) => ({ method: 'POST', path: `/charges/invoices/${a.invoiceId}/record-payment`, body: { method: a.method, amount: a.amount, reference: a.reference } }),
  },
  {
    name: 'remind_unpaid_flats', title: 'Remind unpaid flats', group: 'Charges',
    description: 'Email and notify every resident whose flat has not paid this charge yet.',
    input: { chargeId: uuid('Charge id from list_charges') },
    access: can('charges:manage'),
    request: (a) => ({ method: 'POST', path: `/charges/${a.chargeId}/remind` }),
  },
  {
    name: 'cancel_charge', title: 'Cancel a charge', group: 'Charges', destructive: true,
    description: 'Cancel a charge issued by mistake. Only possible while nobody has paid it.',
    input: { chargeId: uuid('Charge id from list_charges'), confirm },
    access: can('charges:manage'),
    request: (a) => ({ method: 'DELETE', path: `/charges/${a.chargeId}` }),
  },
  {
    name: 'get_stripe_connection_status', title: 'Stripe connection status', group: 'Charges', readOnly: true,
    description: 'Whether the society’s Stripe account is connected, in test or live mode, and whether the webhook is set up. Never shows keys.',
    access: can('tenant:settings'),
    request: () => ({ method: 'GET', path: '/payments/stripe/settings' }),
  },

  /* ===== Platform (Super Admin only) ===== */
  {
    name: 'list_platform_data', title: 'All societies, users, staff and visits', group: 'Platform', readOnly: true,
    description: 'Platform-wide data. Filter visits by society and date range.',
    input: {
      tenantId: z.string().uuid().optional(),
      startDate: z.string().optional().describe('YYYY-MM-DD'), endDate: z.string().optional().describe('YYYY-MM-DD'),
    },
    access: isSuper,
    request: (a) => ({ method: 'GET', path: '/super-admin/data', query: a }),
  },
  {
    name: 'set_society_active', title: 'Suspend or activate a society', group: 'Platform',
    description: 'Suspend a society (everyone in it is locked out) or activate it again.',
    input: { tenantId: uuid('Society id from list_platform_data'), isActive: z.boolean() },
    access: isSuper,
    request: (a) => ({ method: 'PATCH', path: `/super-admin/tenants/${a.tenantId}/status`, body: { isActive: a.isActive } }),
  },
  {
    name: 'delete_society', title: 'Delete a society', group: 'Platform', destructive: true,
    description: 'Delete a society. Everyone in it loses access.',
    input: { tenantId: uuid('Society id'), confirm },
    access: isSuper,
    request: (a) => ({ method: 'DELETE', path: `/super-admin/tenants/${a.tenantId}` }),
  },
  {
    name: 'delete_user', title: 'Delete a user', group: 'Platform', destructive: true,
    description: 'Delete a user account.',
    input: { userId: uuid('User id from list_platform_data'), confirm },
    access: isSuper,
    request: (a) => ({ method: 'DELETE', path: `/super-admin/users/${a.userId}` }),
  },
  {
    name: 'delete_staff_member', title: 'Delete a staff member', group: 'Platform', destructive: true,
    description: 'Delete a staff member record.',
    input: { staffId: uuid('Staff id from list_platform_data'), confirm },
    access: isSuper,
    request: (a) => ({ method: 'DELETE', path: `/super-admin/staff/${a.staffId}` }),
  },
];
