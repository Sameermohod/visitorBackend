"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.COMMUNITY_KEY = exports.directKey = exports.canMessage = exports.isLinked = exports.reachableRoles = exports.COMMUNITY_ROLES = exports.OFFICE_ROLES = void 0;
const db_1 = __importDefault(require("../../configs/db"));
/** The people who run the society day to day. Anyone may write to them; they may write to anyone. */
exports.OFFICE_ROLES = ['Society Admin', 'Society Secretary'];
/** Residents, the board and the accountant talk to each other freely. */
const MEMBER_ROLES = ['Resident', 'Committee Member', 'Accountant', 'Supervisor'];
/** Who can read and post in the society-wide "Community" channel. Guards and repair staff are not in it. */
exports.COMMUNITY_ROLES = [...exports.OFFICE_ROLES, 'Committee Member', 'Resident', 'Accountant', 'Supervisor', 'Tenant'];
/**
 * Which roles a person may start a conversation with, by their own role.
 *  - Tenants and repair staff: only the office (a tenant can also write to their own landlord, see `isLinked`).
 *  - Guards: the office and residents (for a parcel or a visitor at the gate).
 *  - Residents and the board: the office, each other, and guards.
 * `null` means every role (the office).
 */
const reachableRoles = (role) => {
    if (exports.OFFICE_ROLES.includes(role))
        return null;
    if (role === 'Security Guard')
        return [...exports.OFFICE_ROLES, ...MEMBER_ROLES];
    if (MEMBER_ROLES.includes(role))
        return [...exports.OFFICE_ROLES, ...MEMBER_ROLES, 'Security Guard'];
    return exports.OFFICE_ROLES; // Tenant, plumber, electrician, cleaner, ...
};
exports.reachableRoles = reachableRoles;
/** A flat owner and their current tenant may always write to each other. */
const isLinked = async (tenantId, a, b) => {
    const t = await db_1.default.tenancy.findFirst({
        where: {
            tenantId,
            status: 'ACTIVE',
            OR: [{ ownerUserId: a, renterUserId: b }, { ownerUserId: b, renterUserId: a }],
        },
        select: { id: true },
    });
    return !!t;
};
exports.isLinked = isLinked;
const canMessage = async (tenantId, sender, target) => {
    if (sender.id === target.id || target.role === 'Super Admin')
        return false;
    const roles = (0, exports.reachableRoles)(sender.role);
    if (roles === null || roles.includes(target.role))
        return true;
    return (0, exports.isLinked)(tenantId, sender.id, target.id);
};
exports.canMessage = canMessage;
const directKey = (a, b) => [a, b].sort().join(':');
exports.directKey = directKey;
exports.COMMUNITY_KEY = 'community';
