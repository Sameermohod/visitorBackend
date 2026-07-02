"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
async function main() {
    const users = await prisma.user.findMany({
        include: {
            role: true,
            tenant: true
        }
    });
    console.log('--- USERS IN DATABASE ---');
    users.forEach(u => {
        console.log(`- Email: ${u.email}, Name: ${u.firstName} ${u.lastName}, Role: ${u.role.name}, Tenant: ${u.tenant?.slug || 'GLOBAL'}`);
    });
    console.log('-------------------------');
}
main()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
