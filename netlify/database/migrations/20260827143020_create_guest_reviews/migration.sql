CREATE TABLE "reviews" (
	"id" serial PRIMARY KEY,
	"author_name" text NOT NULL,
	"author_email" text,
	"country" text,
	"rating" integer NOT NULL,
	"title" text,
	"body" text NOT NULL,
	"stay_month" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"ip_hash" text,
	"created_at" timestamp DEFAULT now(),
	"moderated_at" timestamp
);
--> statement-breakpoint
CREATE INDEX "reviews_status_created_idx" ON "reviews" ("status","created_at");--> statement-breakpoint
CREATE INDEX "reviews_ip_hash_idx" ON "reviews" ("ip_hash");