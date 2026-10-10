CREATE TABLE "guild_bans" (
	"guild_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"banned_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guild_bans_guild_id_user_id_pk" PRIMARY KEY("guild_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "guild_members" ADD COLUMN "server_muted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "color" text;--> statement-breakpoint
ALTER TABLE "guild_bans" ADD CONSTRAINT "guild_bans_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_bans" ADD CONSTRAINT "guild_bans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Existing servers keep letting everyone attach images and react, as before these bits existed.
UPDATE "roles" SET "permissions" = "permissions" | 24576 WHERE "id" = "guild_id";
