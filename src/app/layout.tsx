import type { Metadata } from "next";
import { cookies } from "next/headers";
import { authenticationService } from "@/services/auth";
import { AppShell } from "./shell";
import "./style.css";

export const metadata: Metadata = {
  title: "OD Signing Workflow",
  description: "Prepare and route OD and permission letters for signing.",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await authenticationService.readSession(
    (await cookies()).get("od_session")?.value,
  );
  return (
    <html lang="en">
      <body>
        <AppShell user={session}>
          <main>{children}</main>
        </AppShell>
      </body>
    </html>
  );
}
