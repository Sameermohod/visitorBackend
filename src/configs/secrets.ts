import crypto from 'crypto';
import logger from './logger';

/**
 * Signing secrets live only in the environment. There is no built-in default any more: a default that is
 * written in the source code is known to everyone who can read it, and lets them forge a login for any user.
 *
 *  - Production: a missing secret stops the server from starting. A short or placeholder one is allowed but warned about.
 *  - Development: a missing secret gets a random one for this run (sessions end when the server restarts).
 */
const isProd = process.env.NODE_ENV === 'production';
const PLACEHOLDER = /change[-_ ]?me|super-secret|your[-_ ]secret|example|password|secret123/i;
const generated = new Map<string, string>();
const warned = new Set<string>();

const read = (name: string): string => {
  const value = process.env[name];
  if (value) {
    if ((value.length < 32 || PLACEHOLDER.test(value)) && !warned.has(name)) {
      warned.add(name);
      logger.warn(`${name} is short or looks like a placeholder. Set it to a random string of 32+ characters (for example: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))").`);
    }
    return value;
  }
  if (isProd) throw new Error(`${name} is not set. Refusing to start without it.`);
  if (!generated.has(name)) {
    generated.set(name, crypto.randomBytes(48).toString('hex'));
    logger.warn(`${name} is not set. Using a random one for this run only. Add it to .env to keep people signed in across restarts.`);
  }
  return generated.get(name)!;
};

/** Call once at start-up so a bad configuration fails immediately, not on the first login. */
export const assertSecrets = () => { accessSecret(); refreshSecret(); };

export const accessSecret = () => read('JWT_ACCESS_SECRET');
export const refreshSecret = () => read('JWT_REFRESH_SECRET');
/** Camera viewing tokens use their own key, so a viewing token can never be mistaken for a login token (or the other way round). */
export const viewSecret = () => crypto.createHmac('sha256', accessSecret()).update('camera-view-token').digest('hex');
