import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { pool } from "@/db/client";
import { authenticationService } from "@/services/auth";
import { DocumentList, type DashboardDocument } from "./document-list";

export default async function DashboardPage() {
  const identity = await authenticationService.readSession(
    (await cookies()).get("od_session")?.value,
  );
  if (!identity) redirect("/sign-in");
  let documents: DashboardDocument[];
  try {
    const result = await pool.query(
      `select d.id,d.title,d.letter_type,d.status,d.created_at,d.completed_at,
              (select count(*) from signers s where s.document_id=d.id) as signer_count,
              (select count(*) from signature_fields f where f.document_id=d.id) as field_count,
              (select s.role from signers s where s.document_id=d.id and s.status='ACTIVE' order by s.sequence limit 1) as active_role,
              (select count(*) from signers s where s.document_id=d.id and s.status='SIGNED') as signed_count
       from documents d where d.owner_user_id=$1 order by d.created_at desc`,
      [identity.userId],
    );
    documents = result.rows as DashboardDocument[];
  } catch {
    return (
      <section className="page-wrap">
        <div className="page-heading">
          <div>
            <p className="eyebrow">Workspace</p>
            <h1>Your documents</h1>
          </div>
        </div>
        <div className="state-card error-state" role="alert">
          <span className="state-icon" aria-hidden="true">
            !
          </span>
          <div>
            <h2>Documents are unavailable</h2>
            <p>We couldn’t load your workspace. Please try again.</p>
          </div>
          <Link className="button secondary" href="/dashboard">
            Retry
          </Link>
        </div>
      </section>
    );
  }
  return (
    <section className="page-wrap">
      <div className="page-heading dashboard-heading">
        <div>
          <p className="eyebrow">Workspace</p>
          <h1>Your documents</h1>
          <p className="intro">
            Track requests, see who has the next action, and open any document
            to continue.
          </p>
        </div>
        <Link className="button" href="/documents/new">
          <span aria-hidden="true">＋</span> Create request
        </Link>
      </div>
      <DocumentList documents={documents} />
    </section>
  );
}
