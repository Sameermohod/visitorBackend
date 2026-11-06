"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.decrypt = exports.encrypt = void 0;
const crypto_1 = __importDefault(require("crypto"));
const logger_1 = __importDefault(require("../configs/logger"));
const secrets_1 = require("../configs/secrets");
// AES-256-GCM for secrets stored in the database (each society's Stripe keys).
// Set ENCRYPTION_KEY to any long random string. Changing it later makes already-stored keys unreadable.
let warned = false;
const getKey = () => {
    let secret = process.env.ENCRYPTION_KEY;
    if (!secret) {
        if (!warned) {
            logger_1.default.warn('ENCRYPTION_KEY is not set. Falling back to a key derived from JWT_REFRESH_SECRET. Set ENCRYPTION_KEY in .env.');
            warned = true;
        }
        secret = (0, secrets_1.refreshSecret)();
    }
    return crypto_1.default.createHash('sha256').update(secret).digest();
};
const encrypt = (plain) => {
    const iv = crypto_1.default.randomBytes(12);
    const cipher = crypto_1.default.createCipheriv('aes-256-gcm', getKey(), iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
};
exports.encrypt = encrypt;
const decrypt = (payload) => {
    const [version, iv, tag, data] = payload.split(':');
    if (version !== 'v1' || !iv || !tag || !data)
        throw new Error('Stored secret has an unknown format.');
    const decipher = crypto_1.default.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
};
exports.decrypt = decrypt;
