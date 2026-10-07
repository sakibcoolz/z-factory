import "next-auth";
import "next-auth/jwt";

declare module "next-auth" {
  interface User {
    sessionVersion?: number;
  }
  interface Session {
    uid?: string;
    sv?: number;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    uid?: string;
    sv?: number;
  }
}
