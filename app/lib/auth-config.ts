import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import bcrypt from "bcryptjs";
import prisma from "./prisma";


export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
        action: { label: "Action", type: "text" },
        firstName: { label: "First Name", type: "text" },
        lastName: { label: "Last Name", type: "text" },
      },
      async authorize(credentials) {
        const email = (credentials.email as string)?.toLowerCase().trim();
        const password = credentials.password as string;
        const action = credentials.action as string;

        if (!email || !password) return null;

        if (action === "register") {
          const existing = await prisma.user.findUnique({ where: { email } });
          if (existing) throw new Error("An account with this email already exists.");

          if (password.length < 6) throw new Error("Password must be at least 6 characters.");

          const passwordHash = await bcrypt.hash(password, 12);
          const user = await prisma.user.create({
            data: {
              email,
              passwordHash,
              firstName: (credentials.firstName as string) || null,
              lastName: (credentials.lastName as string) || null,
            },
          });
          return { id: user.id, email: user.email, name: [user.firstName, user.lastName].filter(Boolean).join(" ") || undefined, image: user.profileImage };
        }

        const user = await prisma.user.findUnique({ where: { email } });
        if (!user) throw new Error("Invalid email or password.");
        if (!user.passwordHash) throw new Error("This account uses Google sign-in. Please use the Google button.");

        const valid = await bcrypt.compare(password, user.passwordHash);
        if (!valid) throw new Error("Invalid email or password.");

        return { id: user.id, email: user.email, name: [user.firstName, user.lastName].filter(Boolean).join(" ") || undefined, image: user.profileImage };
      },
    }),
    Google({
      clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    }),
  ],
  pages: {
    signIn: "/login",
  },
  session: {
    strategy: "jwt",
  },
  callbacks: {
    async signIn({ user, account, profile }) {
      if (account?.provider === "google" && profile?.email) {
        const email = profile.email.toLowerCase();
        const googleId = account.providerAccountId;

        let dbUser = await prisma.user.findUnique({ where: { googleId } });
        if (!dbUser) {
          dbUser = await prisma.user.findUnique({ where: { email } });
          if (dbUser) {
            await prisma.user.update({
              where: { id: dbUser.id },
              data: {
                googleId,
                profileImage: (profile as any).picture || dbUser.profileImage,
              },
            });
          } else {
            dbUser = await prisma.user.create({
              data: {
                email,
                googleId,
                firstName: (profile as any).given_name || null,
                lastName: (profile as any).family_name || null,
                profileImage: (profile as any).picture || null,
              },
            });
          }
        }
        user.id = dbUser.id;
      }
      return true;
    },
    async jwt({ token, user }) {
      if (user) {
        token.userId = user.id;
      }
      return token;
    },
    async session({ session, token }) {
      if (token.userId) {
        session.user.id = token.userId as string;
      }
      return session;
    },
  },
  trustHost: true,
});
