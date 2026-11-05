import crypto from 'crypto';
import logger from '../configs/logger';
import { refreshSecret } from '../configs/secrets';

// AES-256-GCM for secrets stored in the database (each society's Stripe keys).
// Set ENCRYPTION_KEY to any long random string. Changing it later makes already-stored keys unreadable.
let warned = false;

const getKey = (): Buffer => {
  let secret = process.env.ENCRYPTION_KEY;
  if (!secret) {
    if (!warned) {
      logger.warn('ENCRYPTION_KEY is not set. Falling back to a key derived from JWT_REFRESH_SECRET. Set ENCRYPTION_KEY in .env.');
      warned = true;
    }
    secret = refreshSecret();
  }
  return crypto.createHash('sha256').update(secret).digest();
};

export const encrypt = (plain: string): string => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
};

export const decrypt = (payload: string): string => {
  const [version, iv, tag, data] = payload.split(':');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Stored secret has an unknown format.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
};
