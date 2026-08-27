import type { Config, Context } from "@netlify/functions";
import { timingSafeEqual } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { reviews } from "../../db/schema.js";

const STATUSES = ["pending", "approved", "rejected"];

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/** Constant-time comparison so the password cannot be guessed byte by byte. */
function matches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function readPassword(req: Request): string {
  const header = req.headers.get("authorization") || "";
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return (req.headers.get("x-admin-password") || "").trim();
}

export default async (req: Request, context: Context) => {
  const expected = process.env.REVIEWS_ADMIN_PASSWORD;

  // Password protection is optional: storing a secret needs a paid Netlify plan, so with
  // REVIEWS_ADMIN_PASSWORD unset these endpoints are open and the page relies on not being
  // linked or indexed. Set the variable at any time to switch the check back on.
  if (expected) {
    const provided = readPassword(req);
    if (!provided || !matches(provided, expected)) {
      return json({ error: "Incorrect password." }, 401);
    }
  }

  try {
    if (req.method === "GET") {
      const rows = await db
        .select({
          id: reviews.id,
          authorName: reviews.authorName,
          authorEmail: reviews.authorEmail,
          country: reviews.country,
          rating: reviews.rating,
          title: reviews.title,
          body: reviews.body,
          stayMonth: reviews.stayMonth,
          status: reviews.status,
          createdAt: reviews.createdAt,
          moderatedAt: reviews.moderatedAt,
        })
        .from(reviews)
        .orderBy(desc(reviews.createdAt))
        .limit(300);

      const counts = { pending: 0, approved: 0, rejected: 0 };
      for (const row of rows) {
        if (row.status in counts) counts[row.status as keyof typeof counts] += 1;
      }

      return json({ reviews: rows, counts });
    }

    // Netlify retries a 404 from a path-based function against the static pipeline, which
    // re-enters this handler with ".html" appended to the id. Answering 404 rather than 400
    // keeps that retry from masking a genuine "not found" with a confusing parse error.
    const id = Number(context.params?.id);
    if (!Number.isInteger(id) || id < 1) {
      return json({ error: "Review not found." }, 404);
    }

    if (req.method === "DELETE") {
      const deleted = await db.delete(reviews).where(eq(reviews.id, id)).returning({ id: reviews.id });
      if (deleted.length === 0) return json({ error: "Review not found." }, 404);
      return json({ ok: true, id, deleted: true });
    }

    if (req.method === "PATCH" || req.method === "POST") {
      let payload: Record<string, unknown>;
      try {
        payload = await req.json();
      } catch {
        return json({ error: "Invalid request body." }, 400);
      }

      const status = String(payload.status || "");
      if (!STATUSES.includes(status)) {
        return json({ error: `Status must be one of: ${STATUSES.join(", ")}.` }, 422);
      }

      const [updated] = await db
        .update(reviews)
        .set({ status, moderatedAt: new Date() })
        .where(eq(reviews.id, id))
        .returning({ id: reviews.id, status: reviews.status });

      if (!updated) return json({ error: "Review not found." }, 404);
      return json({ ok: true, ...updated });
    }

    return json({ error: "Method not allowed." }, 405);
  } catch (error) {
    console.error("reviews-admin function failed:", error);
    return json({ error: "Moderation is temporarily unavailable." }, 500);
  }
};

export const config: Config = {
  path: ["/api/admin/reviews", "/api/admin/reviews/:id"],
};
