CREATE TABLE "guild_sounds" (
	"guild_id" uuid NOT NULL,
	"event" text NOT NULL,
	"file_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guild_sounds_guild_id_event_pk" PRIMARY KEY("guild_id","event")
);
--> statement-breakpoint
ALTER TABLE "guild_sounds" ADD CONSTRAINT "guild_sounds_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;