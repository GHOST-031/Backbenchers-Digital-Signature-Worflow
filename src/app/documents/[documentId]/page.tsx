import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { authenticationService } from "@/services/auth";
import { DocumentEditor } from "./document-editor";

export default async function DocumentEditorPage({
  params,
}: {
  params: Promise<{ documentId: string }>;
}) {
  const cookieStore = await cookies();
  if (
    !(await authenticationService.readSession(
      cookieStore.get("od_session")?.value,
    ))
  )
    redirect("/sign-in");
  const { documentId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(documentId)) notFound();
  return <DocumentEditor documentId={documentId} />;
}
