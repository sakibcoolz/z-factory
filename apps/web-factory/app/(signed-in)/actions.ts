"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { signOut } from "@/auth";
import { requireActor } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { isDomainError } from "@/lib/domain/errors";
import type { FormState } from "@/lib/form-state";
import { log } from "@/lib/log";
import { createAgent, createSite, registerDeployment } from "@/lib/services/site-service";
import { addMember, changeOwnPassword, setMemberActive, setMemberRole } from "@/lib/services/user-service";

/**
 * The signed-in actions. Each one starts from the session (requireActor) and lets the
 * service decide what the actor's role allows; a refusal comes back as text for the form.
 */

const field = (data: FormData, name: string) => {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
};

async function run(action: string, work: () => Promise<string>, paths: string[]): Promise<FormState> {
  try {
    const notice = await work();
    return { notice };
  } catch (error) {
    if (isDomainError(error)) return { error: error.message };
    log("error", "action failed", { action, error: error instanceof Error ? error.name : "unknown" });
    return { error: "Something went wrong. Try again." };
  } finally {
    for (const path of paths) revalidatePath(path);
  }
}

export async function createSiteAction(organizationId: string, _state: FormState, data: FormData) {
  const actor = await requireActor();
  return run(
    "site.create",
    async () => {
      const site = await createSite(getDb(), actor, organizationId, {
        siteKey: field(data, "siteKey"),
        name: field(data, "name"),
      });
      return `Site ${site.name} created.`;
    },
    [`/orgs/${organizationId}`],
  );
}

export async function createAgentAction(siteId: string, _state: FormState, data: FormData) {
  const actor = await requireActor();
  return run(
    "agent.create",
    async () => {
      const agent = await createAgent(getDb(), actor, siteId, {
        agentKey: field(data, "agentKey"),
        name: field(data, "name"),
      });
      return `Agent ${agent.name} registered.`;
    },
    [`/sites/${siteId}`],
  );
}

export async function registerDeploymentAction(agentId: string, _state: FormState, data: FormData) {
  const actor = await requireActor();
  const file = data.get("deployment");
  return run(
    "plc.register",
    async () => {
      const text = file instanceof File && file.size > 0 ? await file.text() : "";
      const result = await registerDeployment(getDb(), actor, agentId, text);
      return result.unchanged
        ? "This version is registered already."
        : result.created
          ? "PLC registered."
          : "PLC updated to the new version.";
    },
    [`/agents/${agentId}`],
  );
}

export async function addMemberAction(organizationId: string, _state: FormState, data: FormData) {
  const actor = await requireActor();
  return run(
    "member.add",
    async () => {
      await addMember(getDb(), actor, organizationId, {
        email: field(data, "email"),
        name: field(data, "name"),
        role: field(data, "role"),
        password: field(data, "password"),
      });
      return `${field(data, "email")} added.`;
    },
    [`/orgs/${organizationId}/users`],
  );
}

export async function memberAction(organizationId: string, userId: string, _state: FormState, data: FormData) {
  const actor = await requireActor();
  const operation = field(data, "operation");
  return run(
    `member.${operation}`,
    async () => {
      if (operation === "role") {
        await setMemberRole(getDb(), actor, organizationId, userId, field(data, "role"));
        return "Role changed.";
      }
      await setMemberActive(getDb(), actor, organizationId, userId, operation === "enable");
      return operation === "enable" ? "Enabled." : "Disabled.";
    },
    [`/orgs/${organizationId}/users`],
  );
}

export async function changePasswordAction(_state: FormState, data: FormData): Promise<FormState> {
  const actor = await requireActor();
  try {
    await changeOwnPassword(getDb(), actor, field(data, "current"), field(data, "next"));
  } catch (error) {
    if (isDomainError(error)) return { error: error.message };
    throw error;
  }
  // Every session of this user ended with the change, this one too.
  await signOut({ redirect: false });
  redirect("/login");
}

export async function signOutAction() {
  await signOut({ redirectTo: "/login" });
}
