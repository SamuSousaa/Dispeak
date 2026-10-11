CREATE TABLE "friend_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"from_id" uuid NOT NULL,
	"to_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "friend_requests_pair" UNIQUE("from_id","to_id")
);
--> statement-breakpoint
ALTER TABLE "guilds" ADD COLUMN "kind" text DEFAULT 'server' NOT NULL;--> statement-breakpoint
ALTER TABLE "guilds" ADD COLUMN "dm_key" text;--> statement-breakpoint
ALTER TABLE "friend_requests" ADD CONSTRAINT "friend_requests_from_id_users_id_fk" FOREIGN KEY ("from_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friend_requests" ADD CONSTRAINT "friend_requests_to_id_users_id_fk" FOREIGN KEY ("to_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "friend_requests_to_idx" ON "friend_requests" USING btree ("to_id");--> statement-breakpoint
ALTER TABLE "guilds" ADD CONSTRAINT "guilds_dm_key_unique" UNIQUE("dm_key");