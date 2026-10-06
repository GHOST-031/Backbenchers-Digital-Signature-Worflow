import { and, asc, eq, lt, lte, or } from "drizzle-orm";
import { db } from "@/db/client";
import { outboxJobs } from "@/db/schema";

export interface JobInput {
  type: string;
  payload: Record<string, unknown>;
  availableAt?: Date;
}
export interface JobRepository {
  enqueue(job: JobInput): Promise<string>;
  claim(type?: string): Promise<typeof outboxJobs.$inferSelect | null>;
  complete(id: string): Promise<void>;
  fail(id: string, reason: string, retryAt?: Date): Promise<void>;
}
export class PostgresOutbox implements JobRepository {
  async enqueue(job: JobInput): Promise<string> {
    const [row] = await db
      .insert(outboxJobs)
      .values({
        type: job.type,
        payload: job.payload,
        availableAt: job.availableAt,
      })
      .returning({ id: outboxJobs.id });
    if (!row) throw new Error("Outbox enqueue did not return a job id");
    return row.id;
  }
  async claim(type?: string): Promise<typeof outboxJobs.$inferSelect | null> {
    return db.transaction(async (tx) => {
      await tx
        .update(outboxJobs)
        .set({ status: "PENDING", lockedAt: null })
        .where(
          and(
            eq(outboxJobs.status, "PROCESSING"),
            lt(outboxJobs.lockedAt, new Date(Date.now() - 5 * 60_000)),
          ),
        );
      const [candidate] = await tx
        .select()
        .from(outboxJobs)
        .where(
          and(
            or(
              eq(outboxJobs.status, "PENDING"),
              eq(outboxJobs.status, "FAILED"),
            ),
            lte(outboxJobs.availableAt, new Date()),
            ...(type ? [eq(outboxJobs.type, type)] : []),
          ),
        )
        .orderBy(asc(outboxJobs.availableAt))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!candidate) return null;
      const [claimed] = await tx
        .update(outboxJobs)
        .set({
          status: "PROCESSING",
          lockedAt: new Date(),
          attempts: candidate.attempts + 1,
        })
        .where(eq(outboxJobs.id, candidate.id))
        .returning();
      return claimed ?? null;
    });
  }
  async complete(id: string): Promise<void> {
    const rows = await db
      .update(outboxJobs)
      .set({ status: "COMPLETED", completedAt: new Date(), lockedAt: null })
      .where(and(eq(outboxJobs.id, id), eq(outboxJobs.status, "PROCESSING")));
    if (rows.rowCount !== 1)
      throw new Error("Outbox job is not currently processing");
  }
  async fail(
    id: string,
    reason: string,
    retryAt = new Date(Date.now() + 60_000),
  ): Promise<void> {
    const rows = await db
      .update(outboxJobs)
      .set({
        status: "FAILED",
        lastError: reason,
        availableAt: retryAt,
        lockedAt: null,
      })
      .where(and(eq(outboxJobs.id, id), eq(outboxJobs.status, "PROCESSING")));
    if (rows.rowCount !== 1)
      throw new Error("Outbox job is not currently processing");
  }
}
export interface EmailProvider {
  send(to: string, subject: string, body: string): Promise<void>;
}
export class ConsoleEmailProvider implements EmailProvider {
  async send(to: string, subject: string, body: string): Promise<void> {
    console.info("[development email]", { to, subject, body });
  }
}
export const jobRepository: JobRepository = new PostgresOutbox();
export const emailProvider: EmailProvider = new ConsoleEmailProvider();
