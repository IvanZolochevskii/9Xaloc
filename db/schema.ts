import { pgTable, serial, text, integer, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Guest reviews submitted through the site.
 * Nothing is shown publicly until status flips from "pending" to "approved".
 */
export const reviews = pgTable(
  "reviews",
  {
    id: serial().primaryKey(),
    authorName: text("author_name").notNull(),
    authorEmail: text("author_email"),
    country: text(),
    rating: integer().notNull(),
    title: text(),
    body: text().notNull(),
    stayMonth: text("stay_month"),
    status: text().notNull().default("pending"),
    ipHash: text("ip_hash"),
    createdAt: timestamp("created_at").defaultNow(),
    moderatedAt: timestamp("moderated_at"),
  },
  (table) => [
    index("reviews_status_created_idx").on(table.status, table.createdAt),
    index("reviews_ip_hash_idx").on(table.ipHash),
  ]
);
