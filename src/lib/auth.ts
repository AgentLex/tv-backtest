// src/lib/auth.ts
import type { NextAuthOptions } from "next-auth";
import GitHubProvider from "next-auth/providers/github";

const adminEmails = (process.env.ADMIN_EMAILS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

export const authOptions: NextAuthOptions = {
  providers: [
    GitHubProvider({
      clientId: process.env.GITHUB_ID || "",
      clientSecret: process.env.GITHUB_SECRET || "",
      allowDangerousEmailAccountLinking: true,
    }),
  ],
  session: { strategy: "jwt" },
  callbacks: {
    async jwt({ token, profile }) {
      if (profile && (profile as any).email) token.email = (profile as any).email;
      const email = (token.email || "").toLowerCase();
      (token as any).role = adminEmails.includes(email) ? "admin" : "user";
      return token;
    },
    async session({ session, token }) {
      (session.user as any).role = (token as any).role || "user";
      return session;
    },
  },
  secret: process.env.NEXTAUTH_SECRET,
};