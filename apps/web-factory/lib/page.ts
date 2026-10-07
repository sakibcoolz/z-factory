import "server-only";
import { notFound } from "next/navigation";
import { isDomainError } from "@/lib/domain/errors";

/** Loads a page's data; something the actor cannot see is a 404, like something that does not exist. */
export async function load<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (isDomainError(error, "NOT_FOUND") || isDomainError(error, "FORBIDDEN")) notFound();
    throw error;
  }
}
