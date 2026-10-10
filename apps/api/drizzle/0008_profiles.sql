ALTER TABLE "users" ADD COLUMN "banner_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "bio" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "custom_status" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "accent_color" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "presence_mode" text DEFAULT 'online' NOT NULL;