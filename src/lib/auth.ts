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
        // Connexion : on fige la version de jeton du compte dans le JWT.
        // `user` provient de `authorize` (ligne complète moins passwordHash).
        const { emailVerified, tokenVersion } = user as {
          emailVerified?: Date | null;
          tokenVersion?: number;
        };
        token.id = user.id;
        token.emailVerified = emailVerified ? emailVerified.toISOString() : null;
        token.tokenVersion = typeof tokenVersion === "number" ? tokenVersion : 0;
        return token;
      }

      if (!token.id) return token;

      // Compatibilité : un jeton émis avant l'ajout de la colonne n'a pas de
      // `tokenVersion` ; il est traité comme la version 0 (valeur par défaut en
      // base), donc il continue de fonctionner — pas de déconnexion massive au
      // déploiement — mais il sera révoqué au prochain changement de mot de passe.
      const tokenVersion =
        typeof token.tokenVersion === "number" ? token.tokenVersion : 0;

      // Une seule requête, réutilisée à la fois pour rafraîchir `emailVerified`
      // (comportement historique) et pour re-vérifier la version de jeton.
      const dbUser = await db.query.users.findFirst({
        where: (users, { eq }) => eq(users.id, token.id as string),
        columns: { emailVerified: true, tokenVersion: true },
      });

      // Compte supprimé, ou mot de passe changé depuis l'émission du jeton
      // (changePassword / resetPassword incrémentent tokenVersion) : on rejette
      // la session. NextAuth v5 typant `jwt` en `Awaitable<null | JWT>`,
      // retourner `null` invalide le jeton et la session devient non authentifiée.
      if (!dbUser) return null;
      if (tokenVersion !== dbUser.tokenVersion) return null;

      token.emailVerified = dbUser.emailVerified
        ? dbUser.emailVerified.toISOString()
        : null;
      token.tokenVersion = dbUser.tokenVersion;
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
