import prisma from '../../configs/db';

/** The people who run the society day to day. Anyone may write to them; they may write to anyone. */
export const OFFICE_ROLES = ['Society Admin', 'Society Secretary'];

/** Residents, the board and the accountant talk to each other freely. */
const MEMBER_ROLES = ['Resident', 'Committee Member', 'Accountant', 'Supervisor'];

/** Who can read and post in the society-wide "Community" channel. Guards and repair staff are not in it. */
export const COMMUNITY_ROLES = [...OFFICE_ROLES, 'Committee Member', 'Resident', 'Accountant', 'Supervisor', 'Tenant'];

/**
 * Which roles a person may start a conversation with, by their own role.
 *  - Tenants and repair staff: only the office (a tenant can also write to their own landlord, see `isLinked`).
 *  - Guards: the office and residents (for a parcel or a visitor at the gate).
 *  - Residents and the board: the office, each other, and guards.
 * `null` means every role (the office).
 */
export const reachableRoles = (role: string): string[] | null => {
  if (OFFICE_ROLES.includes(role)) return null;
  if (role === 'Security Guard') return [...OFFICE_ROLES, ...MEMBER_ROLES];
  if (MEMBER_ROLES.includes(role)) return [...OFFICE_ROLES, ...MEMBER_ROLES, 'Security Guard'];
  return OFFICE_ROLES; // Tenant, plumber, electrician, cleaner, ...
};

/** A flat owner and their current tenant may always write to each other. */
export const isLinked = async (tenantId: string, a: string, b: string) => {
  const t = await prisma.tenancy.findFirst({
    where: {
      tenantId,
      status: 'ACTIVE',
      OR: [{ ownerUserId: a, renterUserId: b }, { ownerUserId: b, renterUserId: a }],
    },
    select: { id: true },
  });
  return !!t;
};

export const canMessage = async (tenantId: string, sender: { id: string; role: string }, target: { id: string; role: string }) => {
  if (sender.id === target.id || target.role === 'Super Admin') return false;
  const roles = reachableRoles(sender.role);
  if (roles === null || roles.includes(target.role)) return true;
  return isLinked(tenantId, sender.id, target.id);
};

export const directKey = (a: string, b: string) => [a, b].sort().join(':');
export const COMMUNITY_KEY = 'community';
