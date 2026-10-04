import { redirect } from "next/navigation";
import { routes } from "@/lib/navigation/routes";

export default function HomePage() {
  redirect(routes.factories());
}
