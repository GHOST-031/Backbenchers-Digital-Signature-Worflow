import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { authenticationService } from "@/services/auth";
import { SigningPage } from "./signing-page";

export default async function SignerPage({
  params,
}: {
  params: Promise<{ documentId: string }>;
}) {
  const session = await authenticationService.readSession(
    (await cookies()).get("od_session")?.value,
  );
  if (!session) redirect("/sign-in");
  const { documentId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(documentId)) notFound();
  return <SigningPage documentId={documentId} />;
}
