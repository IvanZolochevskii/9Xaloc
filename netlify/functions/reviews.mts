import type { Config, Context } from "@netlify/functions";
import { createHash } from "node:crypto";
import { and, count, eq, desc, gte } from "drizzle-orm";
import { db } from "../../db/index.js";
import { reviews } from "../../db/schema.js";

const MAX_PER_IP_PER_DAY = 3;

const LIMITS = {
  authorName: 60,
  authorEmail: 120,
  country: 60,
  title: 90,
  body: 1500,
  stayMonth: 7,
};

function json(payload: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

/** Trim, drop control characters, and cap the length of a free-text field. */
function clean(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

function hashIp(ip: string): string {
  return createHash("sha256").update(`9xaloc-reviews:${ip}`).digest("hex").slice(0, 32);
}

async function listApproved() {
  const rows = await db
    .select({
      id: reviews.id,
      authorName: reviews.authorName,
      country: reviews.country,
      rating: reviews.rating,
      title: reviews.title,
      body: reviews.body,
      stayMonth: reviews.stayMonth,
      createdAt: reviews.createdAt,
    })
    .from(reviews)
    .where(eq(reviews.status, "approved"))
    .orderBy(desc(reviews.createdAt))
    .limit(60);

  const total = rows.length;
  const average = total
    ? Math.round((rows.reduce((sum, row) => sum + row.rating, 0) / total) * 100) / 100
    : null;

  return { reviews: rows, total, average };
}

async function createReview(req: Request, context: Context) {
  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Invalid request body." }, 400);
  }

  // Honeypot: real guests never see this field, so anything in it is a bot.
  if (clean(payload.website, 200)) {
    return json({ ok: true, status: "pending" }, 202);
  }

  const authorName = clean(payload.authorName, LIMITS.authorName);
  const body = clean(payload.body, LIMITS.body);
  const rating = Number(payload.rating);
  const authorEmail = clean(payload.authorEmail, LIMITS.authorEmail);
  const stayMonth = clean(payload.stayMonth, LIMITS.stayMonth);

  const fields: Record<string, string> = {};
  if (authorName.length < 2) fields.authorName = "Please tell us your name.";
  if (body.length < 20) fields.body = "Please write at least 20 characters.";
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    fields.rating = "Please pick a rating from 1 to 5.";
  }
  if (authorEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(authorEmail)) {
    fields.authorEmail = "That email address looks incomplete.";
  }
  if (stayMonth && !/^\d{4}-(0[1-9]|1[0-2])$/.test(stayMonth)) {
    fields.stayMonth = "Please use the month picker.";
  }

  if (Object.keys(fields).length > 0) {
    return json({ error: "Please check the highlighted fields.", fields }, 422);
  }

  const ipHash = hashIp(context.ip || "unknown");
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [recent] = await db
    .select({ value: count() })
    .from(reviews)
    .where(and(eq(reviews.ipHash, ipHash), gte(reviews.createdAt, since)));

  if (Number(recent?.value ?? 0) >= MAX_PER_IP_PER_DAY) {
    return json({ error: "You have already submitted a review recently. Thank you!" }, 429);
  }

  await db.insert(reviews).values({
    authorName,
    authorEmail: authorEmail || null,
    country: clean(payload.country, LIMITS.country) || null,
    rating,
    title: clean(payload.title, LIMITS.title) || null,
    body,
    stayMonth: stayMonth || null,
    status: "pending",
    ipHash,
  });

  return json(
    {
      ok: true,
      status: "pending",
      message: "Thank you! Your review will be published once we have read it.",
    },
    201
  );
}

export default async (req: Request, context: Context) => {
  try {
    if (req.method === "GET") {
      return json(await listApproved(), 200, {
        "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
      });
    }

    if (req.method === "POST") {
      return await createReview(req, context);
    }

    return json({ error: "Method not allowed." }, 405, { Allow: "GET, POST" });
  } catch (error) {
    console.error("reviews function failed:", error);
    return json({ error: "Reviews are temporarily unavailable." }, 500);
  }
};

export const config: Config = {
  path: "/api/reviews",
};
