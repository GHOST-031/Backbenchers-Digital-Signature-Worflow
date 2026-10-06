import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { authenticationService } from "@/services/auth";
export default async function DashboardPage() {
  const cookieStore = await cookies();
  if (
    !(await authenticationService.readSession(
      cookieStore.get("od_session")?.value,
    ))
  )
    redirect("/sign-in");
  return (
    <section>
      <p className="eyebrow">Workspace</p>
      <h1>Your requests</h1>
      <div className="card">
        <h2>Foundation preview</h2>
        <p>
          Document creation, signing, and audit history will be connected in
          later phases.
        </p>
        <Link className="button secondary" href="/sign-in">
          Application sign-in
        </Link>
      </div>
    </section>
  );
}
