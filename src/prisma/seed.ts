import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding Database... 🌱');

  // 1. Seed Subscriptions
  console.log('Seeding Subscriptions...');
  const basicPlan = await prisma.subscription.upsert({
    where: { name: 'Basic Tier' },
    update: {},
    create: {
      name: 'Basic Tier',
      tier: 'BASIC',
      priceMonthly: 1999.00,
      maxResidents: 250,
      maxGuards: 4,
      features: { visitorManagement: true, billing: true, complaints: true, noticeBoard: true },
    },
  });

  const premiumPlan = await prisma.subscription.upsert({
    where: { name: 'Premium Tier' },
    update: {},
    create: {
      name: 'Premium Tier',
      tier: 'PREMIUM',
      priceMonthly: 4999.00,
      maxResidents: 1000,
      maxGuards: 12,
      features: { visitorManagement: true, billing: true, complaints: true, noticeBoard: true, parkingSlots: true, staffManagement: true, smartIntercom: true },
    },
  });

  const enterprisePlan = await prisma.subscription.upsert({
    where: { name: 'Enterprise Tier' },
    update: {},
    create: {
      name: 'Enterprise Tier',
      tier: 'ENTERPRISE',
      priceMonthly: 9999.00,
      maxResidents: 5000,
      maxGuards: 50,
      features: { visitorManagement: true, billing: true, complaints: true, noticeBoard: true, parkingSlots: true, staffManagement: true, smartIntercom: true, faceRecognition: true, whatsappIntegration: true, ocrScanning: true },
    },
  });

  // 2. Seed Dynamic Roles
  console.log('Seeding Roles...');
  const roles = [
    { name: 'Super Admin', description: 'Global platform operations and SaaS billing overseer' },
    { name: 'Society Admin', description: 'Complete administrator control within a housing tenant' },
    { name: 'Committee Member', description: 'Assists admin, manages notices and approves expenses' },
    { name: 'Resident', description: 'Apartment owner or tenant user' },
    { name: 'Security Guard', description: 'Gate access tracking, cab entries and SOS notifier' },
    { name: 'Maintenance Staff', description: 'Category assigned cleaners, plumbers or electricians' },
    { name: 'Accountant', description: 'Financial ledger manager and invoice overrides accountant' },
  ];

  const dbRoles: Record<string, any> = {};
  for (const role of roles) {
    dbRoles[role.name] = await prisma.role.upsert({
      where: { name: role.name },
      update: { description: role.description },
      create: { name: role.name, description: role.description },
    });
  }

  // 3. Seed Standard Granular Permissions
  console.log('Seeding Permissions...');
  const permissions = [
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

    // Staff attendance
    { code: 'staff:manage', name: 'Manage Staff and Log Attendance', module: 'Staff' },
    
    // Safety alert
    { code: 'safety:sos', name: 'Trigger Emergency SOS Alerts', module: 'Safety' },
  ];

  const dbPermissions: Record<string, any> = {};
  for (const perm of permissions) {
    dbPermissions[perm.code] = await prisma.permission.upsert({
      where: { code: perm.code },
      update: { name: perm.name, module: perm.module },
      create: { code: perm.code, name: perm.name, module: perm.module },
    });
  }

  // 4. Bind Role Permissions Mapping
  console.log('Mapping Permissions to Roles...');
  
  // Define mappings
  const mappings: Record<string, string[]> = {
    'Super Admin': permissions.map((p) => p.code), // Access all
    'Society Admin': [
      'users:view', 'users:edit', 'tenant:settings', 'society:manage',
      'residents:view', 'residents:manage', 'visitors:view', 'visitors:create',
      'visitors:gate', 'complaints:view', 'complaints:create', 'complaints:resolve',
      'billing:view', 'billing:pay', 'billing:manage', 'staff:manage', 'safety:sos'
    ],
    'Committee Member': [
      'users:view', 'residents:view', 'visitors:view', 'visitors:create',
      'complaints:view', 'complaints:resolve', 'billing:view', 'safety:sos'
    ],
    'Resident': [
      'residents:view', 'visitors:create', 'complaints:view', 'complaints:create',
      'billing:view', 'billing:pay', 'safety:sos'
    ],
    'Security Guard': [
      'visitors:view', 'visitors:gate', 'safety:sos'
    ],
    'Maintenance Staff': [
      'complaints:view', 'complaints:resolve'
    ],
    'Accountant': [
      'billing:view', 'billing:manage'
    ],
  };

  for (const [roleName, permCodes] of Object.entries(mappings)) {
    const roleId = dbRoles[roleName].id;
    for (const code of permCodes) {
      const permissionId = dbPermissions[code].id;
      
      // Upsert into RolePermission joining table
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: { roleId, permissionId }
        },
        update: {},
        create: { roleId, permissionId }
      });
    }
  }

  // 5. Seed default global Super Admin Account
  console.log('Generating Super Admin identity...');
  const saRole = dbRoles['Super Admin'];
  const adminRole = dbRoles['Society Admin'];
  const residentRole = dbRoles['Resident'];
  const guardRole = dbRoles['Security Guard'];

  const salt = await bcrypt.genSalt(10);
  const superPasswordHash = await bcrypt.hash('superadmin123', salt);
  const welcomePasswordHash = await bcrypt.hash('welcome123', salt);

  const existingSA = await prisma.user.findFirst({
    where: {
      email: 'superadmin@saassociety.com',
      tenantId: null
    }
  });

  if (!existingSA) {
    await prisma.user.create({
      data: {
        email: 'superadmin@saassociety.com',
        passwordHash: superPasswordHash,
        firstName: 'Global',
        lastName: 'SuperAdmin',
        phoneNumber: '+919999999999',
        roleId: saRole.id,
        isVerified: true,
        tenantId: null
      }
    });
  }

  // 6. Seed default Lotus Heights Demo Workspace
  console.log('Generating Lotus Heights Demo Tenant Space...');
  let tenant = await prisma.tenant.findUnique({
    where: { slug: 'lotus-heights' }
  });

  if (!tenant) {
    tenant = await prisma.tenant.create({
      data: {
        name: 'Lotus Heights',
        slug: 'lotus-heights',
        subscriptionId: basicPlan.id,
        trialEndsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      }
    });
  }

  // Seed Society Structure
  let society = await prisma.society.findFirst({
    where: { tenantId: tenant.id }
  });

  if (!society) {
    society = await prisma.society.create({
      data: {
        tenantId: tenant.id,
        name: 'Lotus Heights Building Complex',
        address: '88 Emerald Avenue, Silicon Hills',
        city: 'Metro City',
        state: 'State Land',
        zipCode: '400001'
      }
    });
  }

  // Seed Building
  let building = await prisma.building.findFirst({
    where: { tenantId: tenant.id, societyId: society.id }
  });

  if (!building) {
    building = await prisma.building.create({
      data: {
        tenantId: tenant.id,
        societyId: society.id,
        name: 'Main Building Tower',
        wingsCount: 1
      }
    });
  }

  // Seed Wing
  let wing = await prisma.wing.findFirst({
    where: { tenantId: tenant.id, buildingId: building.id }
  });

  if (!wing) {
    wing = await prisma.wing.create({
      data: {
        tenantId: tenant.id,
        buildingId: building.id,
        name: 'A',
        floorsCount: 2
      }
    });
  }

  // Seed Flats
  const flatNumbers = ['A-101', 'A-102', 'A-201', 'A-202'];
  const seededFlats: Record<string, any> = {};

  for (const number of flatNumbers) {
    let flat = await prisma.flat.findFirst({
      where: { tenantId: tenant.id, wingId: wing.id, number }
    });

    if (!flat) {
      flat = await prisma.flat.create({
        data: {
          tenantId: tenant.id,
          wingId: wing.id,
          floorNumber: number.startsWith('A-1') ? 1 : 2,
          number,
          type: '2BHK'
        }
      });
    }
    seededFlats[number] = flat;
  }

  // Seed Demo Society Admin user
  let demoAdmin = await prisma.user.findFirst({
    where: { email: 'admin@saassociety.com', tenantId: tenant.id }
  });

  if (!demoAdmin) {
    demoAdmin = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: 'admin@saassociety.com',
        passwordHash: welcomePasswordHash,
        firstName: 'Lotus',
        lastName: 'Admin',
        phoneNumber: '+919876543210',
        roleId: adminRole.id,
        isVerified: true
      }
    });
  }

  // Seed Demo Resident user
  let demoResident = await prisma.user.findFirst({
    where: { email: 'resident@saassociety.com', tenantId: tenant.id }
  });

  if (!demoResident) {
    demoResident = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: 'resident@saassociety.com',
        passwordHash: welcomePasswordHash,
        firstName: 'Rahul',
        lastName: 'Sharma',
        phoneNumber: '+919999911111',
        roleId: residentRole.id,
        isVerified: true
      }
    });
  }

  // Create Resident link for resident user
  let resLink = await prisma.resident.findFirst({
    where: { userId: demoResident.id, tenantId: tenant.id }
  });

  if (!resLink) {
    resLink = await prisma.resident.create({
      data: {
        tenantId: tenant.id,
        userId: demoResident.id,
        flatId: seededFlats['A-101'].id,
        ownershipStatus: 'OWNER',
        familyMembers: [
          { name: 'Pooja Sharma', phone: '+919999911112', relation: 'Spouse' }
        ],
        emergencyContacts: [
          { name: 'Vikram Sharma', phone: '+919999911113', relation: 'Brother' }
        ]
      }
    });
  }

  // Seed Demo Security Guard user
  let demoGuard = await prisma.user.findFirst({
    where: { email: 'guard@saassociety.com', tenantId: tenant.id }
  });

  if (!demoGuard) {
    demoGuard = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: 'guard@saassociety.com',
        passwordHash: welcomePasswordHash,
        firstName: 'Ram',
        lastName: 'Singh',
        phoneNumber: '+919999922222',
        roleId: guardRole.id,
        isVerified: true
      }
    });
  }

  // Create Staff record for Guard
  let guardStaff = await prisma.staff.findFirst({
    where: { userId: demoGuard.id, tenantId: tenant.id }
  });

  if (!guardStaff) {
    guardStaff = await prisma.staff.create({
      data: {
        tenantId: tenant.id,
        userId: demoGuard.id,
        firstName: 'Ram',
        lastName: 'Singh',
        phoneNumber: '+919999922222',
        type: 'Guard',
        salaryMonthly: 18000.00,
        shiftStart: '08:00',
        shiftEnd: '20:00'
      }
    });
  }

  // 7. Seed Demo Visitors and Gate Entry Logs
  console.log('Generating Demo Visitors and active gate entry logs...');
  let demoVisitor1 = await prisma.visitor.findFirst({
    where: { phoneNumber: '9898989898', tenantId: tenant.id }
  });

  if (!demoVisitor1) {
    demoVisitor1 = await prisma.visitor.create({
      data: {
        tenantId: tenant.id,
        name: 'Zomato Delivery',
        phoneNumber: '9898989898',
        visitorType: 'DELIVERY',
        vehicleNumber: 'MH-12-AB-1234',
        company: 'Zomato',
        purpose: 'Food Delivery',
        status: 'DEPARTED',
        qrCode: 'PASS-LOTA-ZOM1',
        validFrom: new Date(Date.now() - 24 * 60 * 60 * 1000),
        validUntil: new Date(Date.now() + 24 * 60 * 60 * 1000)
      }
    });
  }

  let demoVisitor2 = await prisma.visitor.findFirst({
    where: { phoneNumber: '9000000001', tenantId: tenant.id }
  });

  if (!demoVisitor2) {
    demoVisitor2 = await prisma.visitor.create({
      data: {
        tenantId: tenant.id,
        name: 'Ramesh Kumar',
        phoneNumber: '9000000001',
        visitorType: 'GUEST',
        vehicleNumber: 'DL-1C-5678',
        company: 'None',
        purpose: 'Family Visit',
        status: 'IN_SOCIETY',
        qrCode: 'PASS-LOTA-RAM2',
        validFrom: new Date(Date.now() - 24 * 60 * 60 * 1000),
        validUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
        preApprovedBy: resLink.id
      }
    });
  }

  // Seed Visitor logs
  let log1 = await prisma.visitorLog.findFirst({
    where: { visitorId: demoVisitor1.id, tenantId: tenant.id }
  });

  if (!log1) {
    await prisma.visitorLog.create({
      data: {
        tenantId: tenant.id,
        visitorId: demoVisitor1.id,
        flatId: seededFlats['A-101'].id,
        checkedInAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        checkedOutAt: new Date(Date.now() - 1 * 60 * 60 * 1000),
        checkedInBy: demoGuard.id,
        checkedOutBy: demoGuard.id,
        notes: 'Food checked at Main gate A'
      }
    });
  }

  let log2 = await prisma.visitorLog.findFirst({
    where: { visitorId: demoVisitor2.id, tenantId: tenant.id }
  });

  if (!log2) {
    await prisma.visitorLog.create({
      data: {
        tenantId: tenant.id,
        visitorId: demoVisitor2.id,
        flatId: seededFlats['A-101'].id,
        checkedInAt: new Date(Date.now() - 15 * 60 * 1000),
        checkedInBy: demoGuard.id,
        notes: 'Checked in via pre-approved resident pass'
      }
    });
  }

  console.log('Seeding successfully completed! 🎉');
}

main()
  .catch((e) => {
    console.error('Error seeding DB:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
