"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAPPINGS = exports.PERMISSIONS = exports.ROLES = void 0;
exports.seedRolesAndPermissions = seedRolesAndPermissions;
const client_1 = require("@prisma/client");
// Single source of truth for roles, permissions and which role gets which permission.
// Safe to run any number of times. Permissions are added, and ones a role no longer lists are removed.
exports.ROLES = [
    { name: 'Super Admin', description: 'Global platform operations and SaaS billing overseer' },
    { name: 'Society Admin', description: 'Complete administrator control within a housing tenant' },
    {
        name: 'Society Secretary',
        description: 'Chief administrative officer of the society: runs day-to-day operations (members, notices, complaints, staff, visitors, billing). Cannot change society/AI settings or edit user accounts.',
    },
    { name: 'Committee Member', description: 'Assists admin, manages notices and approves expenses' },
    { name: 'Resident', description: 'Apartment owner or tenant user' },
    { name: 'Tenant', description: 'Renter of a flat. Limited access set by the flat owner: visitor passes, complaints and notices. No society bills.' },
    { name: 'Security Guard', description: 'Gate access tracking, cab entries and SOS notifier' },
    { name: 'Maintenance Staff', description: 'Category assigned cleaners, plumbers or electricians' },
    { name: 'Accountant', description: 'Financial ledger manager and invoice overrides accountant' },
];
exports.PERMISSIONS = [
    // Auth & Identity
    { code: 'users:view', name: 'View Users', module: 'Auth' },
    { code: 'users:edit', name: 'Modify Users', module: 'Auth' },
    // Tenant / Society Settings
    { code: 'tenant:settings', name: 'Update Tenant Customizations', module: 'Tenant' },
    { code: 'society:manage', name: 'Manage Society Structures', module: 'Society' },
    // Residents Directory
    { code: 'residents:view', name: 'View Resident Profiles', module: 'Resident' },
    { code: 'residents:manage', name: 'Onboard Residents', module: 'Resident' },
    // Gate & Visitor Pass
    { code: 'visitors:view', name: 'View Visitor Logs', module: 'Visitor' },
    { code: 'visitors:create', name: 'Create Pre-Approved Passes', module: 'Visitor' },
    { code: 'visitors:gate', name: 'Gate Entry Approval Access', module: 'Visitor' },
    // Complaints SLA
    { code: 'complaints:view', name: 'View Complaint Tickets', module: 'Complaint' },
    { code: 'complaints:create', name: 'File Service Requests', module: 'Complaint' },
    { code: 'complaints:resolve', name: 'Resolve or Escalate Tickets', module: 'Complaint' },
    // Billing Ledger
    { code: 'billing:view', name: 'View Maintenance Billing Logs', module: 'Billing' },
    { code: 'billing:pay', name: 'Initiate Digital UPI Payments', module: 'Billing' },
    { code: 'billing:manage', name: 'Generate Recurring society Invoices', module: 'Billing' },
    // Issuing maintenance / function charges and recording offline payments
    { code: 'charges:manage', name: 'Issue Charges and Record Payments', module: 'Billing' },
    // Add cameras and decide who may watch which one
    { code: 'cameras:manage', name: 'Manage Cameras and Who Can Watch', module: 'Camera' },
    // Hide the AI chatbot from a particular person
    { code: 'chat:manage', name: 'Hide or Show the Chatbot for a Person', module: 'Auth' },
    // Notice board
    { code: 'notices:manage', name: 'Publish Society Notices', module: 'Notice' },
    // Staff attendance
    { code: 'staff:manage', name: 'Manage Staff and Log Attendance', module: 'Staff' },
    // Safety alert
    { code: 'safety:sos', name: 'Trigger Emergency SOS Alerts', module: 'Safety' },
];
const ADMIN_PERMISSIONS = [
    'users:view', 'users:edit', 'tenant:settings', 'society:manage',
    'residents:view', 'residents:manage', 'visitors:view', 'visitors:create',
    'visitors:gate', 'complaints:view', 'complaints:create', 'complaints:resolve',
    'billing:view', 'billing:pay', 'billing:manage', 'charges:manage', 'notices:manage', 'chat:manage', 'cameras:manage', 'staff:manage', 'safety:sos',
];
// The Secretary runs operations like the Admin, but the account-level controls stay with the Admin:
//  - tenant:settings  (AI provider / API key and other workspace configuration)
//  - users:edit       (changing who holds which role, i.e. appointing or removing a Secretary)
//  - billing:pay      (a member action, not an office-bearer duty)
const SECRETARY_PERMISSIONS = ADMIN_PERMISSIONS.filter((code) => !['tenant:settings', 'users:edit', 'billing:pay'].includes(code));
exports.MAPPINGS = {
    'Super Admin': exports.PERMISSIONS.map((p) => p.code), // Access all
    'Society Admin': ADMIN_PERMISSIONS,
    'Society Secretary': SECRETARY_PERMISSIONS,
    'Committee Member': [
        'users:view', 'residents:view', 'visitors:view', 'visitors:create',
        'complaints:view', 'complaints:create', 'complaints:resolve', 'billing:view', 'notices:manage', 'safety:sos',
    ],
    // Renters: no billing at all (the owner stays responsible for maintenance); passes and complaints can be switched off by the owner
    'Tenant': ['visitors:create', 'complaints:view', 'complaints:create', 'safety:sos'],
    // (no residents:view: a resident must not be able to list every other resident's details)
    'Resident': [
        'visitors:create', 'complaints:view', 'complaints:create',
        'billing:view', 'billing:pay', 'safety:sos',
    ],
    // Everyone can raise a complaint and follow their own
    'Security Guard': ['visitors:view', 'visitors:gate', 'complaints:create', 'complaints:view', 'safety:sos'],
    'Maintenance Staff': ['complaints:view', 'complaints:create', 'complaints:resolve'],
    'Accountant': ['billing:view', 'billing:manage', 'charges:manage', 'complaints:create', 'complaints:view'],
};
async function seedRolesAndPermissions(prisma) {
    console.log('Seeding Roles...');
    const dbRoles = {};
    for (const role of exports.ROLES) {
        dbRoles[role.name] = await prisma.role.upsert({
            where: { name: role.name },
            update: { description: role.description },
            create: { name: role.name, description: role.description },
        });
    }
    console.log('Seeding Permissions...');
    const dbPermissions = {};
    for (const perm of exports.PERMISSIONS) {
        dbPermissions[perm.code] = await prisma.permission.upsert({
            where: { code: perm.code },
            update: { name: perm.name, module: perm.module },
            create: { code: perm.code, name: perm.name, module: perm.module },
        });
    }
    console.log('Mapping Permissions to Roles...');
    for (const [roleName, codes] of Object.entries(exports.MAPPINGS)) {
        const roleId = dbRoles[roleName].id;
        for (const code of codes) {
            const permissionId = dbPermissions[code].id;
            await prisma.rolePermission.upsert({
                where: { roleId_permissionId: { roleId, permissionId } },
                update: {},
                create: { roleId, permissionId },
            });
        }
    }
    // The mapping above is the source of truth: drop permissions a role no longer has
    for (const [roleName, codes] of Object.entries(exports.MAPPINGS)) {
        const removed = await prisma.rolePermission.deleteMany({
            where: { roleId: dbRoles[roleName].id, permission: { code: { notIn: codes } } },
        });
        if (removed.count)
            console.log(`Removed ${removed.count} outdated permission(s) from ${roleName}.`);
    }
    return { dbRoles, dbPermissions };
}
// `npm run prisma:seed:rbac` — apply role/permission changes to an existing database without re-running the demo data seed
if (require.main === module) {
    const prisma = new client_1.PrismaClient();
    seedRolesAndPermissions(prisma)
        .then(() => console.log('Roles and permissions are up to date.'))
        .catch((e) => {
        console.error(e);
        process.exit(1);
    })
        .finally(() => prisma.$disconnect());
}
