import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { getDb } from "@/lib/db/client";
import { authenticate } from "@/lib/services/user-service";

/**
 * Sign-in for Web Factory (TASK-901, docs/web-factory.md → Identity): e-mail and password
 * against Web Factory's own users. The session is a signed cookie of at most eight hours
 * that carries only the user id and their session version; every request checks both
 * against the database (lib/auth/session.ts), so disabling a user or changing a role or a
 * password ends their sessions at once.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt", maxAge: 8 * 60 * 60, updateAge: 15 * 60 },
  pages: { signIn: "/login" },
  // Behind a proxy set AUTH_URL or AUTH_TRUST_HOST; locally the host is trusted.
  trustHost: process.env.AUTH_TRUST_HOST === "true" || process.env.NODE_ENV !== "production",
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      async authorize(credentials) {
        const user = await authenticate(getDb(), credentials?.email, credentials?.password);
        return user
          ? { id: user.userId, email: user.email, name: user.name, sessionVersion: user.sessionVersion }
          : null;
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.uid = user.id;
        token.sv = user.sessionVersion;
      }
      return token;
    },
    session({ session, token }) {
      session.uid = typeof token.uid === "string" ? token.uid : undefined;
      session.sv = typeof token.sv === "number" ? token.sv : undefined;
      return session;
    },
  },
});
