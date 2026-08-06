import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { db } from "@/lib/db/db";
import * as schema from "@/lib/db/schema";
import { verifyPassword } from "@/lib/auth-utils";
import { and, eq, gt } from "drizzle-orm";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: schema.users,
    accountsTable: schema.accounts,
    sessionsTable: schema.sessions,
    verificationTokensTable: schema.verificationTokens,
  }),
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
  },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials, request) {
        if (!credentials?.email || !credentials?.password) return null;

        const email = credentials.email as string;
        const ipAddress =
          request?.headers?.get("x-forwarded-for")?.split(",")[0]?.trim() ||
          request?.headers?.get("x-real-ip") ||
          undefined;

        const recentFailures = await db.query.loginAttempts.findMany({
          where: and(
            eq(schema.loginAttempts.email, email),
            eq(schema.loginAttempts.successful, false),
            gt(schema.loginAttempts.createdAt, new Date(Date.now() - 15 * 60 * 1000))
          ),
        });

        if (recentFailures.length >= 5) {
          return null;
        }

        const user = await db.query.users.findFirst({
          where: (users, { eq }) => eq(users.email, email),
        });

        let valid = false;
        if (user?.passwordHash) {
          valid = await verifyPassword(credentials.password as string, user.passwordHash);
        }

        await db.insert(schema.loginAttempts).values({
          email,
          ipAddress,
          successful: valid,
        });

        if (!user || !valid) return null;

        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { passwordHash, ...userWithoutPassword } = user;
        return userWithoutPassword;
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        const emailVerified = (user as { emailVerified?: Date | null }).emailVerified;
        token.id = user.id;
        token.emailVerified = emailVerified ? emailVerified.toISOString() : null;
      } else if (token.id && !token.emailVerified) {
        const dbUser = await db.query.users.findFirst({
          where: (users, { eq }) => eq(users.id, token.id as string),
          columns: { emailVerified: true },
        });
        token.emailVerified = dbUser?.emailVerified
          ? dbUser.emailVerified.toISOString()
          : null;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        (session.user as { emailVerified?: string | null }).emailVerified =
          token.emailVerified as string | null | undefined;
      }
      return session;
    },
  },
});
