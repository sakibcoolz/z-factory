"use server";

import { AuthError } from "next-auth";
import { signIn } from "@/auth";
import type { FormState } from "@/lib/form-state";

/** Signs in; a failure never says whether the e-mail exists or the account is locked. */
export async function signInAction(_state: FormState, data: FormData): Promise<FormState> {
  try {
    await signIn("credentials", {
      email: String(data.get("email") ?? ""),
      password: String(data.get("password") ?? ""),
      redirectTo: "/",
    });
    return {};
  } catch (error) {
    // Success throws a redirect, which must pass through.
    if (error instanceof AuthError) return { error: "The e-mail or password is not right, or the account is locked." };
    throw error;
  }
}
