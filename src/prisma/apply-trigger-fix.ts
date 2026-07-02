import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const sql = `
CREATE OR REPLACE FUNCTION log_user_modifications()
RETURNS TRIGGER AS $$
DECLARE
    v_user_id UUID := NULL;
    v_tenant_id UUID := NULL;
    v_action VARCHAR(100);
    v_row JSONB;
BEGIN
    v_action := TG_OP;
    
    IF (TG_OP = 'INSERT' OR TG_OP = 'UPDATE') THEN
        v_row := to_jsonb(NEW);
        v_tenant_id := (v_row->>'tenant_id')::UUID;
        
        -- Safely extract user ID dynamically from possible columns
        IF (v_row ? 'updated_by' AND v_row->>'updated_by' IS NOT NULL) THEN
            v_user_id := (v_row->>'updated_by')::UUID;
        ELSIF (v_row ? 'created_by' AND v_row->>'created_by' IS NOT NULL) THEN
            v_user_id := (v_row->>'created_by')::UUID;
        ELSIF (v_row ? 'user_id' AND v_row->>'user_id' IS NOT NULL) THEN
            v_user_id := (v_row->>'user_id')::UUID;
        ELSIF (v_row ? 'raised_by' AND v_row->>'raised_by' IS NOT NULL) THEN
            v_user_id := (v_row->>'raised_by')::UUID;
        END IF;

        INSERT INTO audit_logs (tenant_id, user_id, action, resource_type, resource_id, metadata)
        VALUES (v_tenant_id, v_user_id, TG_TABLE_NAME || '_' || v_action, TG_TABLE_NAME, NEW.id, v_row);
        RETURN NEW;
    ELSIF (TG_OP = 'DELETE') THEN
        v_row := to_jsonb(OLD);
        v_tenant_id := (v_row->>'tenant_id')::UUID;
        
        -- Safely extract user ID dynamically from possible columns
        IF (v_row ? 'updated_by' AND v_row->>'updated_by' IS NOT NULL) THEN
            v_user_id := (v_row->>'updated_by')::UUID;
        ELSIF (v_row ? 'user_id' AND v_row->>'user_id' IS NOT NULL) THEN
            v_user_id := (v_row->>'user_id')::UUID;
        ELSIF (v_row ? 'raised_by' AND v_row->>'raised_by' IS NOT NULL) THEN
            v_user_id := (v_row->>'raised_by')::UUID;
        END IF;

        INSERT INTO audit_logs (tenant_id, user_id, action, resource_type, resource_id, metadata)
        VALUES (v_tenant_id, v_user_id, TG_TABLE_NAME || '_DELETE', TG_TABLE_NAME, OLD.id, v_row);
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;
`;

async function main() {
  console.log('Applying trigger fix to PostgreSQL...');
  await prisma.$executeRawUnsafe(sql);
  console.log('Trigger fix successfully applied! 🎉');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
