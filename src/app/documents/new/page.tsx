import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { authenticationService } from "@/services/auth";
import { NewDocumentForm } from "./new-document-form";

export default async function NewDocumentPage() {
  const cookieStore = await cookies();
  if (
    !(await authenticationService.readSession(
      cookieStore.get("od_session")?.value,
    ))
  )
    redirect("/sign-in");
  return (
    <section>
      <p className="eyebrow">New request</p>
      <h1>Upload your document</h1>
      <p className="intro">
        Create an OD or permission request. The PDF stays in private storage.
      </p>
      <NewDocumentForm />
    </section>
  );
}
