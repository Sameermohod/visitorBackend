"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChatController = void 0;
const zod_1 = require("zod");
const db_1 = __importDefault(require("../../configs/db"));
const apiResponse_1 = __importDefault(require("../../utils/apiResponse"));
const logger_1 = __importDefault(require("../../configs/logger"));
const chatMessageSchema = zod_1.z.object({
    message: zod_1.z.string().min(1),
    history: zod_1.z.array(zod_1.z.object({
        role: zod_1.z.enum(['user', 'model', 'assistant', 'system']),
        text: zod_1.z.string(),
    })).optional().default([]),
});
class ChatController {
    // Main chat completions assistant
    static async chat(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const userId = req.user.id;
            const userRole = req.user.role;
            const { message, history } = chatMessageSchema.parse(req.body);
            // 1. Fetch Tenant settings to check AI eligibility
            const tenant = await db_1.default.tenant.findUnique({
                where: { id: tenantId },
            });
            if (!tenant || !tenant.aiEnabled || !tenant.aiApiKey) {
                return apiResponse_1.default.error(res, 'AI Chat Assistant is not enabled for this society. Please contact the administrator.', null, 400);
            }
            const apiKey = tenant.aiApiKey;
            const provider = tenant.aiProvider; // GEMINI or OPENAI
            // 2. Fetch Resident link if the user is a resident
            const resident = await db_1.default.resident.findFirst({
                where: { userId, tenantId, deletedAt: null },
            });
            // 3. Define the database lookup tools
            const executeTool = async (name, args) => {
                logger_1.default.info(`AI Chat: Executing tool "${name}" for tenant ${tenantId}, user ${userId}`);
                switch (name) {
                    case 'get_my_profile':
                        return {
                            firstName: req.user.firstName,
                            lastName: req.user.lastName,
                            email: req.user.email,
                            role: userRole,
                        };
                    case 'get_society_info':
                        const society = await db_1.default.society.findFirst({
                            where: { tenantId, deletedAt: null },
                            select: {
                                name: true,
                                address: true,
                                city: true,
                                state: true,
                                zipCode: true,
                                buildings: {
                                    where: { deletedAt: null },
                                    select: {
                                        name: true,
                                        wingsCount: true,
                                    },
                                },
                            },
                        });
                        return society || { message: 'No society info found.' };
                    case 'get_my_flat':
                        if (userRole !== 'Resident')
                            return { error: 'Access denied: only residents can query personal flat details.' };
                        if (!resident)
                            return { error: 'No resident flat link found.' };
                        const residentFlat = await db_1.default.resident.findFirst({
                            where: { id: resident.id, tenantId },
                            include: {
                                flat: {
                                    include: {
                                        wing: {
                                            include: {
                                                building: true,
                                            },
                                        },
                                    },
                                },
                            },
                        });
                        return residentFlat?.flat
                            ? {
                                number: residentFlat.flat.number,
                                type: residentFlat.flat.type,
                                floor: residentFlat.flat.floorNumber,
                                wing: residentFlat.flat.wing.name,
                                building: residentFlat.flat.wing.building.name,
                                ownershipStatus: residentFlat.ownershipStatus,
                            }
                            : { message: 'No flat is assigned to your resident profile yet.' };
                    case 'get_my_bills':
                        if (userRole !== 'Resident')
                            return { error: 'Access denied: only residents can query personal flat bills.' };
                        if (!resident || !resident.flatId)
                            return { error: 'No flat assigned to your profile.' };
                        const bills = await db_1.default.maintenanceInvoice.findMany({
                            where: { flatId: resident.flatId, tenantId, deletedAt: null },
                            orderBy: { dueDate: 'desc' },
                            select: {
                                invoiceNumber: true,
                                totalAmount: true,
                                paidAmount: true,
                                dueDate: true,
                                status: true,
                                billPeriodStart: true,
                                billPeriodEnd: true,
                            },
                        });
                        return bills;
                    case 'get_my_visitor_passes':
                        if (userRole !== 'Resident')
                            return { error: 'Access denied: only residents can query visitor passes.' };
                        if (!resident)
                            return { error: 'No resident profile link found.' };
                        const passes = await db_1.default.visitor.findMany({
                            where: { preApprovedBy: resident.id, tenantId },
                            orderBy: { createdAt: 'desc' },
                            select: {
                                name: true,
                                phoneNumber: true,
                                visitorType: true,
                                qrCode: true,
                                status: true,
                                validUntil: true,
                            },
                        });
                        return passes;
                    case 'get_my_complaints':
                        let complaintsWhereClause = { tenantId, deletedAt: null };
                        if (userRole === 'Resident') {
                            complaintsWhereClause.raisedBy = userId;
                        }
                        else if (userRole === 'Maintenance Staff') {
                            complaintsWhereClause.assignedTo = userId;
                        }
                        else if (userRole !== 'Society Admin' && userRole !== 'Super Admin' && userRole !== 'Committee Member' && userRole !== 'Accountant') {
                            return { error: 'Access denied: unauthorized.' };
                        }
                        const complaints = await db_1.default.complaint.findMany({
                            where: complaintsWhereClause,
                            orderBy: { createdAt: 'desc' },
                            select: {
                                ticketNumber: true,
                                title: true,
                                description: true,
                                category: true,
                                priority: true,
                                status: true,
                                createdAt: true,
                            },
                        });
                        return complaints;
                    case 'get_residents_directory':
                        if (userRole !== 'Society Admin' && userRole !== 'Super Admin' && userRole !== 'Committee Member' && userRole !== 'Accountant') {
                            return { error: 'Access denied: administrative permissions required.' };
                        }
                        const allResidents = await db_1.default.resident.findMany({
                            where: { tenantId, deletedAt: null },
                            include: {
                                user: {
                                    select: { firstName: true, lastName: true, email: true, phoneNumber: true },
                                },
                                flat: {
                                    select: { number: true },
                                },
                            },
                        });
                        return allResidents.map((r) => ({
                            name: `${r.user.firstName} ${r.user.lastName}`,
                            email: r.user.email,
                            phone: r.user.phoneNumber,
                            flat: r.flat?.number || 'N/A',
                            status: r.ownershipStatus,
                        }));
                    case 'get_visitor_logs':
                        if (userRole !== 'Society Admin' && userRole !== 'Super Admin' && userRole !== 'Security Guard' && userRole !== 'Committee Member') {
                            return { error: 'Access denied: unauthorized.' };
                        }
                        const logs = await db_1.default.visitorLog.findMany({
                            where: { tenantId },
                            orderBy: { checkedInAt: 'desc' },
                            take: 20,
                            include: {
                                visitor: { select: { name: true, visitorType: true } },
                                flat: { select: { number: true } },
                            },
                        });
                        return logs.map((l) => ({
                            visitor: l.visitor.name,
                            type: l.visitor.visitorType,
                            flat: l.flat.number,
                            checkIn: l.checkedInAt,
                            checkOut: l.checkedOutAt || 'Still inside',
                        }));
                    case 'get_complaints':
                        if (userRole !== 'Society Admin' && userRole !== 'Super Admin' && userRole !== 'Committee Member') {
                            return { error: 'Access denied: administrative permissions required.' };
                        }
                        const allComplaints = await db_1.default.complaint.findMany({
                            where: { tenantId, deletedAt: null },
                            orderBy: { createdAt: 'desc' },
                            include: {
                                resident: { select: { firstName: true, lastName: true } },
                            },
                        });
                        return allComplaints.map((c) => ({
                            ticket: c.ticketNumber,
                            title: c.title,
                            raisedBy: `${c.resident.firstName} ${c.resident.lastName}`,
                            category: c.category,
                            priority: c.priority,
                            status: c.status,
                            createdAt: c.createdAt,
                        }));
                    case 'get_billing_summary':
                        if (userRole !== 'Society Admin' && userRole !== 'Super Admin') {
                            return { error: 'Access denied: society administrator role required. Supervisor and other roles are restricted.' };
                        }
                        const invoices = await db_1.default.maintenanceInvoice.findMany({
                            where: { tenantId, deletedAt: null },
                        });
                        const totalBilled = invoices.reduce((acc, inv) => acc + Number(inv.totalAmount), 0);
                        const totalCollected = invoices.reduce((acc, inv) => acc + Number(inv.paidAmount), 0);
                        return {
                            totalBilled,
                            totalCollected,
                            outstanding: totalBilled - totalCollected,
                            invoicesCount: invoices.length,
                            unpaidCount: invoices.filter((i) => i.status === 'UNPAID').length,
                        };
                    case 'get_staff':
                        if (userRole !== 'Society Admin' && userRole !== 'Super Admin' && userRole !== 'Committee Member') {
                            return { error: 'Access denied: unauthorized.' };
                        }
                        const staff = await db_1.default.staff.findMany({
                            where: { tenantId, deletedAt: null },
                            select: {
                                firstName: true,
                                lastName: true,
                                phoneNumber: true,
                                type: true,
                                shiftStart: true,
                                shiftEnd: true,
                            },
                        });
                        return staff;
                    case 'search_directory':
                        if (userRole !== 'Society Admin' && userRole !== 'Super Admin' && userRole !== 'Committee Member' && userRole !== 'Security Guard') {
                            return { error: 'Access denied: directory search restricted.' };
                        }
                        const searchQuery = args.query || '';
                        const foundResidents = await db_1.default.resident.findMany({
                            where: {
                                tenantId,
                                deletedAt: null,
                                OR: [
                                    { user: { firstName: { contains: searchQuery, mode: 'insensitive' } } },
                                    { user: { lastName: { contains: searchQuery, mode: 'insensitive' } } },
                                    { user: { email: { contains: searchQuery, mode: 'insensitive' } } },
                                    { user: { phoneNumber: { contains: searchQuery, mode: 'insensitive' } } },
                                ]
                            },
                            include: {
                                user: {
                                    select: { firstName: true, lastName: true, email: true, phoneNumber: true }
                                },
                                flat: {
                                    select: {
                                        number: true,
                                        vehicles: {
                                            select: { plateNumber: true, model: true }
                                        }
                                    }
                                }
                            }
                        });
                        const foundStaff = await db_1.default.staff.findMany({
                            where: {
                                tenantId,
                                deletedAt: null,
                                OR: [
                                    { firstName: { contains: searchQuery, mode: 'insensitive' } },
                                    { lastName: { contains: searchQuery, mode: 'insensitive' } },
                                    { phoneNumber: { contains: searchQuery, mode: 'insensitive' } },
                                ]
                            }
                        });
                        // Guard restriction: Cannot see email/phone details
                        if (userRole === 'Security Guard') {
                            return {
                                residents: foundResidents.map((r) => ({
                                    type: 'Resident',
                                    name: `${r.user?.firstName || ''} ${r.user?.lastName || ''}`,
                                    flat: r.flat?.number || 'N/A',
                                    status: r.ownershipStatus,
                                    vehicles: r.flat?.vehicles?.map((v) => v.plateNumber) || [],
                                    emergencyContacts: r.emergencyContacts || [],
                                })),
                                staff: foundStaff.map((s) => ({
                                    type: 'Staff/Guard',
                                    name: `${s.firstName} ${s.lastName}`,
                                    role: s.type,
                                    shift: `${s.shiftStart} - ${s.shiftEnd}`,
                                })),
                            };
                        }
                        return {
                            residents: foundResidents.map((r) => ({
                                id: r.id,
                                type: 'Resident',
                                name: `${r.user?.firstName || ''} ${r.user?.lastName || ''}`,
                                email: r.user?.email,
                                phone: r.user?.phoneNumber,
                                flat: r.flat?.number || 'N/A',
                                status: r.ownershipStatus,
                            })),
                            staff: foundStaff.map((s) => ({
                                id: s.id,
                                type: 'Staff/Guard',
                                name: `${s.firstName} ${s.lastName}`,
                                phone: s.phoneNumber,
                                role: s.type,
                                shift: `${s.shiftStart} - ${s.shiftEnd}`,
                            })),
                        };
                    case 'get_user_details':
                        if (userRole !== 'Society Admin' && userRole !== 'Super Admin' && userRole !== 'Committee Member' && userRole !== 'Security Guard') {
                            return { error: 'Access denied: unauthorized.' };
                        }
                        const targetId = args.userId;
                        const targetType = args.type;
                        if (targetType === 'Resident') {
                            const resDetails = await db_1.default.resident.findFirst({
                                where: { id: targetId, tenantId, deletedAt: null },
                                include: {
                                    user: {
                                        select: { firstName: true, lastName: true, email: true, phoneNumber: true, isVerified: true, createdAt: true }
                                    },
                                    flat: {
                                        include: {
                                            wing: {
                                                include: {
                                                    building: true
                                                }
                                            },
                                            vehicles: true
                                        }
                                    }
                                }
                            });
                            if (!resDetails)
                                return { error: 'Resident not found.' };
                            // Guard restriction: Mask email, phone and financial info
                            if (userRole === 'Security Guard') {
                                return {
                                    type: 'Resident',
                                    name: `${resDetails.user?.firstName || ''} ${resDetails.user?.lastName || ''}`,
                                    flat: resDetails.flat ? {
                                        number: resDetails.flat.number,
                                        type: resDetails.flat.type,
                                        floor: resDetails.flat.floorNumber,
                                        wing: resDetails.flat.wing?.name,
                                        building: resDetails.flat.wing?.building?.name
                                    } : 'N/A',
                                    vehicles: resDetails.flat?.vehicles?.map((v) => ({ plate: v.plateNumber, model: v.model })) || [],
                                    emergencyContacts: resDetails.emergencyContacts || []
                                };
                            }
                            return {
                                id: resDetails.id,
                                type: 'Resident',
                                name: `${resDetails.user?.firstName || ''} ${resDetails.user?.lastName || ''}`,
                                email: resDetails.user?.email,
                                phone: resDetails.user?.phoneNumber,
                                verified: resDetails.user?.isVerified,
                                onboardedAt: resDetails.onboardedAt,
                                ownershipStatus: resDetails.ownershipStatus,
                                flat: resDetails.flat ? {
                                    number: resDetails.flat.number,
                                    type: resDetails.flat.type,
                                    floor: resDetails.flat.floorNumber,
                                    wing: resDetails.flat.wing?.name,
                                    building: resDetails.flat.wing?.building?.name
                                } : 'N/A',
                                familyMembers: resDetails.familyMembers || [],
                                emergencyContacts: resDetails.emergencyContacts || []
                            };
                        }
                        else {
                            const staffDetails = await db_1.default.staff.findFirst({
                                where: { id: targetId, tenantId, deletedAt: null },
                                include: {
                                    user: {
                                        select: { email: true, isVerified: true }
                                    }
                                }
                            });
                            if (!staffDetails)
                                return { error: 'Staff member not found.' };
                            // Guard restriction: Strip salary info
                            if (userRole === 'Security Guard') {
                                return {
                                    type: 'Staff/Guard',
                                    name: `${staffDetails.firstName} ${staffDetails.lastName}`,
                                    phone: staffDetails.phoneNumber,
                                    role: staffDetails.type,
                                    shiftStart: staffDetails.shiftStart,
                                    shiftEnd: staffDetails.shiftEnd,
                                };
                            }
                            return {
                                id: staffDetails.id,
                                type: 'Staff/Guard',
                                name: `${staffDetails.firstName} ${staffDetails.lastName}`,
                                phone: staffDetails.phoneNumber,
                                role: staffDetails.type,
                                shiftStart: staffDetails.shiftStart,
                                shiftEnd: staffDetails.shiftEnd,
                                salaryMonthly: userRole === 'Society Admin' || userRole === 'Super Admin' ? Number(staffDetails.salaryMonthly || 0) : 'Hidden',
                                onboardedAt: staffDetails.createdAt,
                                linkedUser: staffDetails.user ? {
                                    email: staffDetails.user.email,
                                    verified: staffDetails.user.isVerified
                                } : 'No credentials generated'
                            };
                        }
                    case 'verify_vehicle':
                        if (userRole !== 'Society Admin' && userRole !== 'Super Admin' && userRole !== 'Committee Member' && userRole !== 'Security Guard') {
                            return { error: 'Access denied: unauthorized.' };
                        }
                        const targetPlate = args.plateNumber || '';
                        const vehicle = await db_1.default.vehicle.findFirst({
                            where: {
                                tenantId,
                                plateNumber: { contains: targetPlate, mode: 'insensitive' }
                            },
                            include: {
                                flat: {
                                    include: {
                                        residents: {
                                            include: {
                                                user: { select: { firstName: true, lastName: true } }
                                            }
                                        }
                                    }
                                }
                            }
                        });
                        return vehicle ? {
                            owner: vehicle.flat?.residents?.map((r) => `${r.user?.firstName || ''} ${r.user?.lastName || ''}`).join(', ') || 'N/A',
                            plate: vehicle.plateNumber,
                            model: vehicle.model,
                            flat: vehicle.flat?.number || 'N/A'
                        } : { message: 'Vehicle not registered in the society directory.' };
                    case 'get_staff_attendance':
                        if (userRole !== 'Society Admin' && userRole !== 'Super Admin' && userRole !== 'Committee Member') {
                            return { error: 'Access denied: administrative permissions required.' };
                        }
                        const attendance = await db_1.default.staffAttendance.findMany({
                            where: { tenantId },
                            orderBy: { checkIn: 'desc' },
                            take: 15,
                            include: {
                                staff: true
                            }
                        });
                        return attendance.map(a => ({
                            staffName: `${a.staff.firstName} ${a.staff.lastName}`,
                            type: a.staff.type,
                            checkIn: a.checkIn,
                            checkOut: a.checkOut || 'Active',
                            status: a.status
                        }));
                    case 'get_notices':
                        const noticesList = await db_1.default.notice.findMany({
                            where: { tenantId, deletedAt: null },
                            orderBy: { publishAt: 'desc' },
                            take: 10
                        });
                        return noticesList.map(n => ({
                            title: n.title,
                            content: n.content,
                            category: n.category,
                            date: n.publishAt
                        }));
                    default:
                        return { error: `Tool "${name}" is not implemented.` };
                }
            };
            // 4. Define Declarations of available tools
            const toolDeclarations = [
                {
                    name: 'get_my_profile',
                    description: 'Get profile information of the logged-in user (name, email, role).',
                    parameters: { type: 'OBJECT', properties: {} },
                },
                {
                    name: 'get_society_info',
                    description: 'Get details about this housing society complex (name, address, building towers).',
                    parameters: { type: 'OBJECT', properties: {} },
                },
                {
                    name: 'get_my_flat',
                    description: "Get configuration details of the resident's assigned flat (BHK type, wing, building). Only available for Residents.",
                    parameters: { type: 'OBJECT', properties: {} },
                },
                {
                    name: 'get_my_bills',
                    description: "Get all maintenance invoices (amount, due date, payment status) for the resident's flat. Only available for Residents.",
                    parameters: { type: 'OBJECT', properties: {} },
                },
                {
                    name: 'get_my_visitor_passes',
                    description: 'Get recent pre-approved visitor passes generated by the logged-in resident.',
                    parameters: { type: 'OBJECT', properties: {} },
                },
                {
                    name: 'get_my_complaints',
                    description: 'Get a list of service complaints raised by the logged-in user.',
                    parameters: { type: 'OBJECT', properties: {} },
                },
                {
                    name: 'get_residents_directory',
                    description: 'Get a list of all residents registered in the society. Admin/Committee only.',
                    parameters: { type: 'OBJECT', properties: {} },
                },
                {
                    name: 'get_visitor_logs',
                    description: 'Get the last 20 visitor check-in/out gate activity logs. Admin/Guard/Committee only.',
                    parameters: { type: 'OBJECT', properties: {} },
                },
                {
                    name: 'get_complaints',
                    description: 'Get a list of all complaints filed in the society. Admin/Committee only.',
                    parameters: { type: 'OBJECT', properties: {} },
                },
                {
                    name: 'get_billing_summary',
                    description: 'Get a financial overview of billing collections and outstanding balances. Admin only.',
                    parameters: { type: 'OBJECT', properties: {} },
                },
                {
                    name: 'get_staff',
                    description: 'Get list of society staff members, guards, plumbers, electricians. Admin/Committee only.',
                    parameters: { type: 'OBJECT', properties: {} },
                },
                {
                    name: 'search_directory',
                    description: 'Search for any resident, user, or staff member in the housing society by name, email, or phone. Admin/Committee only.',
                    parameters: {
                        type: 'OBJECT',
                        properties: {
                            query: { type: 'STRING', description: 'Name, email, or phone number substring to search for.' }
                        },
                        required: ['query']
                    },
                },
                {
                    name: 'get_user_details',
                    description: 'Fetch complete, detailed profile of a resident or staff member, including flat layouts, family members, shifts, and contacts. Admin/Committee only.',
                    parameters: {
                        type: 'OBJECT',
                        properties: {
                            userId: { type: 'STRING', description: 'The unique ID of the resident or staff member (retrieved via search_directory).' },
                            type: { type: 'STRING', description: 'Must be either "Resident" or "Staff/Guard".' }
                        },
                        required: ['userId', 'type']
                    },
                },
                {
                    name: 'verify_vehicle',
                    description: 'Verify if a vehicle plate number belongs to a resident in the society. Guard/Admin/Supervisor only.',
                    parameters: {
                        type: 'OBJECT',
                        properties: {
                            plateNumber: { type: 'STRING', description: 'The vehicle plate number to verify.' }
                        },
                        required: ['plateNumber']
                    },
                },
                {
                    name: 'get_staff_attendance',
                    description: 'Get recent shifts and attendance check-in logs of society staff. Admin/Supervisor only.',
                    parameters: { type: 'OBJECT', properties: {} },
                },
                {
                    name: 'get_notices',
                    description: 'Get today\'s notices and announcements published in the housing society complex. Available to all roles.',
                    parameters: { type: 'OBJECT', properties: {} },
                },
            ];
            // System instruction setting the behavior guidelines
            const systemInstruction = `You are a helpful, premium AI Assistant for the "${tenant.name}" Housing Society management portal.
You have access to tools that query real-time database records. You MUST answer queries using these tools.
Strict Tenant Isolation is enforced.
Role-Based Access Control is active:
- Admin (Society Admin, Super Admin) has FULL access to all data, financials, directory, staff, bills.
- Supervisor (Committee Member, Accountant) can view complaints, staff, visitor logs, notices, but CANNOT view financial billing summary or settings.
- Guard (Security Guard) can verify visitor logs, vehicles, look up residents (limited details like flat, status, emergency contacts; NO emails/phone/financials).
- Maintenance Staff (Cleaner, Electrician, Plumber) can view complaints assigned to them and notices only.
- Flat Owner/Tenant (Resident) can view their flat details, own bills, passes, raised complaints, and notices only.
If a tool returns "Access denied", explain this polite policy limitation. Today's date is: ${new Date().toLocaleDateString()}.`;
            // 5. Execute LLM Query Turn
            let finalMessage = '';
            if (provider === 'GEMINI') {
                // --- GEMINI REST INTEGRATION ---
                const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
                // Format history into Gemini format
                const contents = [];
                history.forEach((h) => {
                    contents.push({
                        role: h.role === 'user' ? 'user' : 'model',
                        parts: [{ text: h.text }],
                    });
                });
                // Add current user prompt
                contents.push({
                    role: 'user',
                    parts: [{ text: message }],
                });
                // Loop up to 3 turns for tool calling
                let turn = 0;
                let complete = false;
                let payload = {
                    contents,
                    systemInstruction: { parts: [{ text: systemInstruction }] },
                    tools: [{ functionDeclarations: toolDeclarations }],
                };
                while (turn < 3 && !complete) {
                    turn++;
                    logger_1.default.info(`AI Chat: Gemini API POST Turn ${turn}`);
                    const response = await fetch(geminiUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload),
                    });
                    if (!response.ok) {
                        const errBody = await response.text();
                        throw new Error(`Gemini API error: ${response.status} - ${errBody}`);
                    }
                    const resJson = await response.json();
                    const candidate = resJson.candidates?.[0];
                    const part = candidate?.content?.parts?.[0];
                    if (part && part.functionCall) {
                        // LLM requested a tool call!
                        const toolName = part.functionCall.name;
                        const toolArgs = part.functionCall.args || {};
                        // Execute local database search
                        const toolResult = await executeTool(toolName, toolArgs);
                        // Append model function call request to contents
                        payload.contents.push(candidate.content);
                        // Append function response to contents
                        payload.contents.push({
                            role: 'function',
                            parts: [{
                                    functionResponse: {
                                        name: toolName,
                                        response: { result: toolResult },
                                    },
                                }],
                        });
                    }
                    else if (part && part.text) {
                        // Regular text response
                        finalMessage = part.text;
                        complete = true;
                    }
                    else {
                        // Fallback
                        finalMessage = "I'm sorry, I couldn't process that request.";
                        complete = true;
                    }
                }
            }
            else {
                // --- OPENAI REST INTEGRATION ---
                const openaiUrl = 'https://api.openai.com/v1/chat/completions';
                // Format history for OpenAI
                const messages = [{ role: 'system', content: systemInstruction }];
                history.forEach((h) => {
                    messages.push({
                        role: h.role === 'model' ? 'assistant' : h.role,
                        content: h.text,
                    });
                });
                // Add current user prompt
                messages.push({ role: 'user', content: message });
                // Map declarations to OpenAI format
                const oaiTools = toolDeclarations.map((t) => ({
                    type: 'function',
                    function: {
                        name: t.name,
                        description: t.description,
                        parameters: {
                            type: 'object',
                            properties: t.parameters.properties,
                            required: [],
                        },
                    },
                }));
                let turn = 0;
                let complete = false;
                let payload = {
                    model: 'gpt-4o-mini',
                    messages,
                    tools: oaiTools,
                    tool_choice: 'auto',
                };
                while (turn < 3 && !complete) {
                    turn++;
                    logger_1.default.info(`AI Chat: OpenAI API POST Turn ${turn}`);
                    const response = await fetch(openaiUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            Authorization: `Bearer ${apiKey}`,
                        },
                        body: JSON.stringify(payload),
                    });
                    if (!response.ok) {
                        const errBody = await response.text();
                        throw new Error(`OpenAI API error: ${response.status} - ${errBody}`);
                    }
                    const resJson = await response.json();
                    const choice = resJson.choices?.[0];
                    const assistantMessage = choice?.message;
                    if (assistantMessage && assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
                        // Push assistant tool call request to messages list
                        payload.messages.push(assistantMessage);
                        // Execute all requested tool calls in parallel or sequence
                        for (const toolCall of assistantMessage.tool_calls) {
                            const toolName = toolCall.function.name;
                            const toolArgs = JSON.parse(toolCall.function.arguments || '{}');
                            // Run database search
                            const toolResult = await executeTool(toolName, toolArgs);
                            // Append tool response
                            payload.messages.push({
                                role: 'tool',
                                tool_call_id: toolCall.id,
                                name: toolName,
                                content: JSON.stringify(toolResult),
                            });
                        }
                    }
                    else if (assistantMessage && assistantMessage.content) {
                        finalMessage = assistantMessage.content;
                        complete = true;
                    }
                    else {
                        finalMessage = "I'm sorry, I couldn't process that request.";
                        complete = true;
                    }
                }
            }
            return apiResponse_1.default.success(res, { response: finalMessage }, 'Assistant response compiled successfully');
        }
        catch (error) {
            logger_1.default.error(`AI Chat completion failed: ${error.message}`);
            return apiResponse_1.default.error(res, error.message || 'Failed to communicate with AI provider. Check your API key settings.', null, 500);
        }
    }
}
exports.ChatController = ChatController;
exports.default = ChatController;
