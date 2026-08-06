import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

function validateEnv() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL environment variable is not set. " +
        "Please configure it in your .env file. See .env.example for reference."
    );
  }

  if (!process.env.AUTH_SECRET || process.env.AUTH_SECRET.length < 32) {
    throw new Error(
      "AUTH_SECRET environment variable is not set or too short (min 32 chars). " +
        "Generate with: openssl rand -base64 32"
    );
  }
}

validateEnv();

const client = postgres(process.env.DATABASE_URL!);
export const db = drizzle(client, { schema });
