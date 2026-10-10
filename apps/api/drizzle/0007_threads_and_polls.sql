ALTER TYPE "public"."channel_type" ADD VALUE 'thread';--> statement-breakpoint
CREATE TABLE "poll_options" (
	"id" uuid PRIMARY KEY NOT NULL,
	"message_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"text" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "poll_votes" (
	"option_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "poll_votes_option_id_user_id_pk" PRIMARY KEY("option_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "polls" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"question" text NOT NULL,
	"multiple" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "poll_options" ADD CONSTRAINT "poll_options_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_option_id_poll_options_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."poll_options"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "polls" ADD CONSTRAINT "polls_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "poll_options_message_idx" ON "poll_options" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "poll_votes_message_idx" ON "poll_votes" USING btree ("message_id");