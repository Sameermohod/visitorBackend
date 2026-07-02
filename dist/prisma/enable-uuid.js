"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const pg_1 = require("pg");
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
async function main() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
        console.error('DATABASE_URL is not defined in environment.');
        process.exit(1);
    }
    const client = new pg_1.Client({
        connectionString,
    });
    try {
        await client.connect();
        console.log('Connected to PG database. Enabling uuid-ossp extension...');
        await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";');
        console.log('uuid-ossp extension enabled successfully! 🎉');
    }
    catch (err) {
        console.error('Error enabling uuid-ossp extension:', err);
        process.exit(1);
    }
    finally {
        await client.end();
    }
}
main();
