import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

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
